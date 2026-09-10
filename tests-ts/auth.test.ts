import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
  type TestClient,
} from './helpers.js';

describe('session authentication and Laravel compatibility', () => {
  let setup: TestApp;
  let client: TestClient;

  beforeAll(async () => {
    setup = await createTestApp();
  });
  beforeEach(async () => {
    await setup.reset();
    client = createClient(setup.app);
    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);
  });
  afterAll(async () => {
    await setup?.close();
  });

  it('bootstraps host-only session and readable CSRF cookies', async () => {
    const response = await client.request('/api/v1/auth/csrf-cookie');
    await expectStatus(response, 204);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    const session = cookies.find((cookie) =>
      cookie.startsWith(`${setup.config.sessionCookie}=`),
    )!;
    const csrf = cookies.find((cookie) => cookie.startsWith('XSRF-TOKEN='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
  });

  it('registers a normalized buyer and initial store, then rotates the session', async () => {
    const originalSession = client.cookies.get(setup.config.sessionCookie);
    const originalToken = client.cookies.get('XSRF-TOKEN');
    const response = await client.json('/api/v1/auth/register', 'POST', {
      name: ' 田中 太郎 ',
      email: ' TANAKA@EXAMPLE.COM ',
      password: 'strong-password',
      role: 'seller',
      points: 999999,
    });
    await expectStatus(response, 201);
    const { data } = await response.json();
    expect(data).toMatchObject({
      name: '田中 太郎',
      role: 'buyer',
      roleLabel: '購入者',
      avatarInitial: '田',
    });
    expect(Object.keys(data).sort()).toEqual(
      ['avatarInitial', 'id', 'name', 'role', 'roleLabel', 'storeId'].sort(),
    );
    const [user] = await setup.db.query<{
      email: string;
      password: string;
    }>('SELECT email, password FROM users WHERE id = ?', [data.id]);
    expect(user!.email).toBe('tanaka@example.com');
    expect(await bcrypt.compare('strong-password', user!.password)).toBe(true);
    const [store] = await setup.db.query<{
      owner_id: string;
      name: string;
      level: number;
      points: number;
      sync_status: string;
    }>(
      'SELECT owner_id, name, level, points, sync_status FROM stores WHERE id = ?',
      [data.storeId],
    );
    expect(store).toEqual({
      owner_id: data.id,
      name: '田中 太郎の店舗',
      level: 1,
      points: 0,
      sync_status: 'offline',
    });
    expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(
      originalSession,
    );
    expect(client.cookies.get('XSRF-TOKEN')).not.toBe(originalToken);
    expect(
      await setup.db.query('SELECT id FROM hono_sessions WHERE id = ?', [
        originalSession,
      ]),
    ).toEqual([]);
    const me = await client.request('/api/v1/auth/me');
    await expectStatus(me, 200);
    expect(await me.json()).toEqual({ data });
  });

  it('rejects duplicate email after normalization without creating an extra store', async () => {
    const response = await client.json('/api/v1/auth/register', 'POST', {
      name: '新しい購入者',
      email: ' DEMO@MINETENANT.JP ',
      password: 'strong-password',
    });
    await expectStatus(response, 422);
    expect((await response.json()).errors.email).toEqual([
      'このメールアドレスは既に登録されています。',
    ]);
    expect(
      await setup.db.query('SELECT id FROM users WHERE name = ?', [
        '新しい購入者',
      ]),
    ).toEqual([]);
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
  });

  it('handles concurrent registration of the same email with one atomic user/store creation', async () => {
    const second = createClient(setup.app);
    await second.request('/api/v1/auth/csrf-cookie');
    const payload = {
      name: '同時登録',
      email: 'race@example.com',
      password: 'strong-password',
    };
    const responses = await Promise.all([
      client.json('/api/v1/auth/register', 'POST', payload),
      second.json('/api/v1/auth/register', 'POST', payload),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 422,
    ]);
    const rejected = responses.find((response) => response.status === 422)!;
    expect((await rejected.json()).errors.email).toEqual([
      'このメールアドレスは既に登録されています。',
    ]);
    const users = await setup.db.query<{ id: string }>(
      'SELECT id FROM users WHERE email = ?',
      ['race@example.com'],
    );
    expect(users).toHaveLength(1);
    expect(
      await setup.db.query('SELECT id FROM stores WHERE owner_id = ?', [
        users[0]!.id,
      ]),
    ).toHaveLength(1);
  });

  it('validates registration fields, including optional password confirmation', async () => {
    const response = await client.json('/api/v1/auth/register', 'POST', {
      name: '',
      email: 'not-an-email',
      password: 'short',
      password_confirmation: 'different',
    });
    await expectStatus(response, 422);
    expect(Object.keys((await response.json()).errors).sort()).toEqual(
      ['name', 'email', 'password', 'password_confirmation'].sort(),
    );
    await expectStatus(
      await client.json('/api/v1/auth/register', 'POST', {
        name: '確認する購入者',
        email: 'confirmation@example.com',
        password: 'strong-password',
        password_confirmation: 'strong-password',
      }),
      201,
    );
  });

  it.each(['あ'.repeat(25), 'a'.repeat(73), 'password\0hidden'])(
    'rejects unsafe bcrypt registration input %j',
    async (password) => {
      const response = await client.json('/api/v1/auth/register', 'POST', {
        name: '購入者',
        email: 'unsafe@example.com',
        password,
      });
      await expectStatus(response, 422);
      expect((await response.json()).errors.password).toBeDefined();
      expect(
        await setup.db.query('SELECT id FROM users WHERE email = ?', [
          'unsafe@example.com',
        ]),
      ).toEqual([]);
    },
  );

  it('accepts existing Laravel $2y$ passwords and normalizes email on login', async () => {
    const hash = (await bcrypt.hash('laravel-password', 4)).replace(
      /^\$2b\$/,
      '$2y$',
    );
    await setup.db.execute('UPDATE users SET password = ? WHERE email = ?', [
      hash,
      'demo@minetenant.jp',
    ]);
    const originalSession = client.cookies.get(setup.config.sessionCookie);
    const response = await client.login(
      ' DEMO@MINETENANT.JP ',
      'laravel-password',
    );
    await expectStatus(response, 200);
    const { data } = await response.json();
    expect(data).toMatchObject({
      id: 'user-buyer',
      storeId: 'store-yamada',
    });
    expect(data).not.toHaveProperty('password');
    expect(data).not.toHaveProperty('remember_token');
    expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(
      originalSession,
    );
  });

  it('returns identical credential errors for wrong passwords and unknown email', async () => {
    const wrong = await client.login('demo@minetenant.jp', 'wrong-password');
    const unknown = await client.login('unknown@example.com', 'wrong-password');
    await expectStatus(wrong, 422);
    await expectStatus(unknown, 422);
    expect(await wrong.json()).toEqual(await unknown.json());
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
  });

  it('returns validation errors for missing and non-string credentials', async () => {
    const missing = await client.json('/api/v1/auth/login', 'POST', {});
    await expectStatus(missing, 422);
    expect(Object.keys((await missing.json()).errors).sort()).toEqual([
      'email',
      'password',
    ]);
    const invalid = await client.json('/api/v1/auth/login', 'POST', {
      email: ['invalid'],
      password: 'password',
    });
    await expectStatus(invalid, 422);
    expect((await invalid.json()).errors.email).toBeDefined();
  });

  it('rejects passwords with bcrypt-truncated suffixes or NUL on login', async () => {
    const password = 'a'.repeat(72);
    await setup.db.execute('UPDATE users SET password = ? WHERE email = ?', [
      await bcrypt.hash(password, 4),
      'demo@minetenant.jp',
    ]);
    await expectStatus(await client.login('demo@minetenant.jp', password), 200);
    await expectStatus(await client.json('/api/v1/auth/logout', 'POST'), 204);
    for (const invalid of [password + 'suffix', 'password\0hidden']) {
      const response = await client.login('demo@minetenant.jp', invalid);
      await expectStatus(response, 422);
      expect((await response.json()).errors.password).toBeDefined();
    }
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
  });

  it('requires a session-bound CSRF token, and accepts both supported header names', async () => {
    const payload = { email: 'demo@minetenant.jp', password: 'password' };
    await expectStatus(
      await setup.app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      419,
    );
    await expectStatus(
      await client.request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-XSRF-TOKEN': 'wrong-token',
        },
        body: JSON.stringify(payload),
      }),
      419,
    );
    const other = createClient(setup.app);
    await other.request('/api/v1/auth/csrf-cookie');
    await expectStatus(
      await client.request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-XSRF-TOKEN': other.cookies.get('XSRF-TOKEN')!,
        },
        body: JSON.stringify(payload),
      }),
      419,
    );
    await expectStatus(
      await client.request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': client.cookies.get('XSRF-TOKEN')!,
        },
        body: JSON.stringify(payload),
      }),
      200,
    );
  });

  it('keeps sessions after recreating the app and invalidates old IDs at logout', async () => {
    await expectStatus(await client.login(), 200);
    const originalSession = client.cookies.get(setup.config.sessionCookie)!;
    const originalToken = client.cookies.get('XSRF-TOKEN');
    const recreated = createApp({ db: setup.db, config: setup.config });
    await expectStatus(
      await recreated.request('/api/v1/auth/me', {
        headers: {
          Cookie: `${setup.config.sessionCookie}=${originalSession}`,
        },
      }),
      200,
    );
    await expectStatus(await client.json('/api/v1/auth/logout', 'POST'), 204);
    expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(
      originalSession,
    );
    expect(client.cookies.get('XSRF-TOKEN')).not.toBe(originalToken);
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
    await expectStatus(
      await recreated.request('/api/v1/auth/me', {
        headers: {
          Cookie: `${setup.config.sessionCookie}=${originalSession}`,
        },
      }),
      401,
    );
    expect(
      await setup.db.query('SELECT id FROM hono_sessions WHERE id = ?', [
        originalSession,
      ]),
    ).toEqual([]);
  });

  it('expires idle sessions and replaces the cookie with an anonymous session', async () => {
    await expectStatus(await client.login(), 200);
    const previous = client.cookies.get(setup.config.sessionCookie)!;
    await setup.db.execute(
      'UPDATE hono_sessions SET expires_at = ? WHERE id = ?',
      [Date.now() - 1, previous],
    );
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
    expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(previous);
  });

  it('limits five attempts per email/IP across login, registration and app instances', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const path =
        attempt % 2 === 0 ? '/api/v1/auth/login' : '/api/v1/auth/register';
      await expectStatus(
        await client.json(path, 'POST', {
          name: '',
          email: 'demo@minetenant.jp',
          password: 'wrong-password',
        }),
        422,
      );
    }
    const recreated = createClient(
      createApp({ db: setup.db, config: setup.config }),
    );
    await recreated.request('/api/v1/auth/csrf-cookie');
    const limited = await recreated.login(' DEMO@MINETENANT.JP ', 'password');
    await expectStatus(limited, 429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    await setup.db.execute('UPDATE hono_rate_limits SET expires_at = ?', [
      Date.now() - 1,
    ]);
    await expectStatus(await recreated.login(), 200);
  });

  it('does not consume the shared IP limit for attempts already blocked by the email limit', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          email: 'limited@example.com',
          password: '',
        }),
        422,
      );
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          email: 'limited@example.com',
          password: '',
        }),
        429,
      );
    }
    for (let attempt = 0; attempt < 25; attempt++) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          email: `available${attempt}@example.com`,
          password: '',
        }),
        422,
      );
    }
    const limited = await client.json('/api/v1/auth/login', 'POST', {
      email: 'final@example.com',
      password: '',
    });
    await expectStatus(limited, 429);
    expect(limited.headers.get('X-RateLimit-Limit')).toBe('30');
  });

  it('also caps attempts from one IP across different email addresses', async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          email: `attempt${attempt}@example.com`,
          password: '',
        }),
        422,
      );
    }
    const limited = await client.json('/api/v1/auth/login', 'POST', {
      email: 'new-address@example.com',
      password: '',
    });
    await expectStatus(limited, 429);
    expect(limited.headers.get('X-RateLimit-Limit')).toBe('30');
  });
});
