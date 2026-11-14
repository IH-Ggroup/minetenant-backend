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

describe('session authentication', () => {
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
      username: ' TANAKA_TARO ',
      displayName: ' 田中 太郎 ',
      password: 'strong-password',
      role: 'seller',
      points: 999999,
    });
    await expectStatus(response, 201);
    const { data } = await response.json();
    expect(data).toEqual({
      id: expect.any(String),
      username: 'tanaka_taro',
      displayName: '田中 太郎',
      role: 'buyer',
      roleLabel: '購入者',
      avatarInitial: '田',
      storeId: expect.any(String),
    });
    const [user] = await setup.db.query<{
      username: string;
      password_hash: string;
      email: null;
      password: null;
    }>(
      'SELECT username, password_hash, email, password FROM users WHERE user_id = ?',
      [data.id],
    );
    expect(user).toMatchObject({
      username: 'tanaka_taro',
      email: null,
      password: null,
    });
    expect(await bcrypt.compare('strong-password', user!.password_hash)).toBe(
      true,
    );
    const [store] = await setup.db.query<{
      user_id: string;
      name: string;
      level: number;
      points: number;
      sync_status: string;
    }>(
      'SELECT user_id, name, level, points, sync_status FROM stores WHERE store_id = ?',
      [data.storeId],
    );
    expect(store).toEqual({
      user_id: data.id,
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
      await setup.db.query(
        'SELECT session_id FROM hono_sessions WHERE session_id = ?',
        [originalSession],
      ),
    ).toEqual([]);
    await expectStatus(await client.request('/api/v1/auth/me'), 200);
  });

  it('rejects removed registration fields without creating a store', async () => {
    const response = await client.json('/api/v1/auth/register', 'POST', {
      name: '新しい購入者',
      email: ' DEMO@MINETENANT.JP ',
      password: 'strong-password',
    });
    await expectStatus(response, 422);
    expect((await response.json()).errors.email).toEqual([
      'この登録項目は利用できません。',
    ]);
    expect(
      await setup.db.query('SELECT user_id FROM users WHERE name = ?', [
        '新しい購入者',
      ]),
    ).toEqual([]);
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
  });

  it('handles concurrent registration of the same username with one atomic user/store creation', async () => {
    const second = createClient(setup.app);
    await second.request('/api/v1/auth/csrf-cookie');
    const payload = {
      username: 'auth_race_user',
      displayName: '同時登録',
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
    expect((await rejected.json()).errors.username).toEqual([
      'このユーザー名は既に登録されています。',
    ]);
    const users = await setup.db.query<{ user_id: string }>(
      'SELECT user_id FROM users WHERE username = ?',
      ['auth_race_user'],
    );
    expect(users).toHaveLength(1);
    expect(
      await setup.db.query('SELECT store_id FROM stores WHERE user_id = ?', [
        users[0]!.user_id,
      ]),
    ).toHaveLength(1);
  });

  it('validates canonical registration fields and password confirmation', async () => {
    const response = await client.json('/api/v1/auth/register', 'POST', {
      username: 'ab',
      displayName: 42,
      password: 'short',
      passwordConfirmation: 'different',
    });
    await expectStatus(response, 422);
    expect(Object.keys((await response.json()).errors).sort()).toEqual(
      ['username', 'displayName', 'password', 'passwordConfirmation'].sort(),
    );
    await expectStatus(
      await client.json('/api/v1/auth/register', 'POST', {
        username: 'confirmation_user',
        displayName: '確認する購入者',
        password: 'strong-password',
        passwordConfirmation: 'strong-password',
      }),
      201,
    );
  });

  it.each(['あ'.repeat(25), 'a'.repeat(73), 'password\0hidden'])(
    'rejects unsafe bcrypt registration input %j',
    async (password) => {
      const response = await client.json('/api/v1/auth/register', 'POST', {
        username: 'unsafe_user',
        displayName: '購入者',
        password,
      });
      await expectStatus(response, 422);
      expect((await response.json()).errors.password).toBeDefined();
      expect(
        await setup.db.query('SELECT user_id FROM users WHERE username = ?', [
          'unsafe_user',
        ]),
      ).toEqual([]);
    },
  );

  it('accepts bcrypt $2y$ password hashes on username login', async () => {
    const hash = (await bcrypt.hash('bcrypt-2y-password', 4)).replace(
      /^\$2b\$/,
      '$2y$',
    );
    await setup.db.execute(
      'UPDATE users SET password_hash = ? WHERE username = ?',
      [hash, 'demo'],
    );
    const originalSession = client.cookies.get(setup.config.sessionCookie);
    const response = await client.login(' DEMO ', 'bcrypt-2y-password');
    await expectStatus(response, 200);
    const { data } = await response.json();
    expect(data).toMatchObject({
      id: 'user-buyer',
      storeId: 'store-yamada',
    });
    expect(data).not.toHaveProperty('password');
    expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(
      originalSession,
    );
  });

  it('returns identical credential errors for wrong passwords and unknown usernames', async () => {
    const wrong = await client.login('demo', 'wrong-password');
    const unknown = await client.login('unknown_user', 'wrong-password');
    await expectStatus(wrong, 401);
    await expectStatus(unknown, 401);
    expect(await wrong.json()).toEqual(await unknown.json());
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
  });

  it('returns validation errors for missing and non-string credentials', async () => {
    const missing = await client.json('/api/v1/auth/login', 'POST', {});
    await expectStatus(missing, 422);
    expect(Object.keys((await missing.json()).errors).sort()).toEqual([
      'password',
      'username',
    ]);
    const invalid = await client.json('/api/v1/auth/login', 'POST', {
      username: ['invalid'],
      password: 'password',
    });
    await expectStatus(invalid, 422);
    expect((await invalid.json()).errors.username).toBeDefined();
  });

  it('rejects passwords with bcrypt-truncated suffixes or NUL on login', async () => {
    const password = 'a'.repeat(72);
    await setup.db.execute(
      'UPDATE users SET password_hash = ? WHERE username = ?',
      [await bcrypt.hash(password, 4), 'demo'],
    );
    await expectStatus(await client.login('demo', password), 200);
    await expectStatus(await client.json('/api/v1/auth/logout', 'POST'), 204);
    for (const invalid of [password + 'suffix', 'password\0hidden']) {
      const response = await client.login('demo', invalid);
      await expectStatus(response, 422);
      expect((await response.json()).errors.password).toBeDefined();
    }
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
  });

  it('requires a session-bound CSRF token, and accepts both supported header names', async () => {
    const payload = { username: 'demo', password: 'password' };
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
    expect(client.cookies.get(setup.config.sessionCookie)).toBeUndefined();
    expect(client.cookies.get('XSRF-TOKEN')).toBeUndefined();
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
      await setup.db.query(
        'SELECT session_id FROM hono_sessions WHERE session_id = ?',
        [originalSession],
      ),
    ).toEqual([]);
  });

  it('does not replace an expired session outside CSRF bootstrap', async () => {
    await expectStatus(await client.login(), 200);
    const previous = client.cookies.get(setup.config.sessionCookie)!;
    await setup.db.execute(
      'UPDATE hono_sessions SET expires_at = ? WHERE session_id = ?',
      [Date.now() - 1, previous],
    );
    const response = await client.request('/api/v1/auth/me');
    await expectStatus(response, 401);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(client.cookies.get(setup.config.sessionCookie)).toBe(previous);
    expect(
      await setup.db.query(
        'SELECT session_id FROM hono_sessions WHERE session_id <> ? AND expires_at > ?',
        [previous, Date.now()],
      ),
    ).toEqual([]);
  });

  it('limits five attempts per username and IP across app instances', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          username: 'demo',
          password: 'wrong-password',
        }),
        401,
      );
    }
    const recreated = createClient(
      createApp({ db: setup.db, config: setup.config }),
    );
    await recreated.request('/api/v1/auth/csrf-cookie');
    const limited = await recreated.login(' DEMO ', 'password');
    await expectStatus(limited, 429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    await setup.db.execute('UPDATE hono_rate_limits SET expires_at = ?', [
      Date.now() - 1,
    ]);
    await expectStatus(await recreated.login(), 200);
  });

  it('does not consume the shared IP limit for attempts already blocked by the username limit', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          username: 'limited_user',
          password: 'wrong-password',
        }),
        401,
      );
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          username: 'limited_user',
          password: 'wrong-password',
        }),
        429,
      );
    }
    for (let attempt = 0; attempt < 25; attempt++) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          username: `available_${attempt}`,
          password: 'wrong-password',
        }),
        401,
      );
    }
    const limited = await client.json('/api/v1/auth/login', 'POST', {
      username: 'final_user',
      password: 'wrong-password',
    });
    await expectStatus(limited, 429);
    expect(limited.headers.get('X-RateLimit-Limit')).toBe('30');
  });

  it('also caps attempts from one IP across different usernames', async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          username: `attempt_${attempt}`,
          password: 'wrong-password',
        }),
        401,
      );
    }
    const limited = await client.json('/api/v1/auth/login', 'POST', {
      username: 'new_user',
      password: 'wrong-password',
    });
    await expectStatus(limited, 429);
    expect(limited.headers.get('X-RateLimit-Limit')).toBe('30');
  });
});
