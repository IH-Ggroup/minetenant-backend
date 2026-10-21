import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../src/app.js';
import { syntheticEmailCandidate } from '../src/db/auth-backfill.js';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
  type TestClient,
} from './helpers.js';

const invalidCredentials = {
  message: 'ユーザー名またはパスワードが正しくありません。',
};

describe('username login cutover gate', () => {
  let setup: TestApp;
  let client: TestClient;

  beforeAll(async () => {
    setup = await createTestApp({ usernameAuthEnabled: true });
  });

  beforeEach(async () => {
    await setup.reset();
    await prepareBuyer();
    client = createClient(setup.app);
    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);
  });

  afterAll(async () => {
    await setup?.close();
  });

  async function prepareBuyer(
    options: {
      email?: string;
      username?: string;
      displayName?: string;
      passwordHash?: string;
      legacyPasswordHash?: string;
    } = {},
  ) {
    const [seeded] = await setup.db.query<{ password: string }>(
      'SELECT password FROM users WHERE user_id = ?',
      ['user-buyer'],
    );
    const passwordHash = options.passwordHash ?? seeded!.password;
    await setup.db.execute(
      `UPDATE users
          SET username = ?, display_name = ?, password_hash = ?,
              password = ?, email = ?
        WHERE user_id = ?`,
      [
        options.username ?? 'demo_user',
        options.displayName ?? '山田 みどり',
        passwordHash,
        options.legacyPasswordHash ?? passwordHash,
        options.email ?? 'demo@minetenant.jp',
        'user-buyer',
      ],
    );
    return passwordHash;
  }

  async function usernameLogin(
    target: TestClient,
    username = 'demo_user',
    password = 'password',
  ) {
    return target.json('/api/v1/auth/login', 'POST', {
      username,
      password,
    });
  }

  it('keeps the legacy request and response contract while the gate is false', async () => {
    const legacy = createClient(
      createApp({
        db: setup.db,
        config: { ...setup.config, usernameAuthEnabled: false },
      }),
    );
    await expectStatus(await legacy.request('/api/v1/auth/csrf-cookie'), 204);

    const rejected = await usernameLogin(legacy);
    await expectStatus(rejected, 422);
    expect((await rejected.json()).errors).toHaveProperty('email');

    const response = await legacy.json('/api/v1/auth/login', 'POST', {
      email: ' DEMO@MINETENANT.JP ',
      password: 'password',
    });
    await expectStatus(response, 200);
    expect(await response.json()).toEqual({
      data: {
        id: 'user-buyer',
        name: '山田 みどり',
        role: 'buyer',
        roleLabel: '購入者デモ',
        avatarInitial: '山',
        storeId: 'store-yamada',
      },
    });
  });

  it('normalizes username, returns the transitional DTO, and rotates the session', async () => {
    const previousSession = client.cookies.get(setup.config.sessionCookie)!;
    const previousCsrf = client.cookies.get('XSRF-TOKEN')!;

    const response = await usernameLogin(client, ' DEMO_USER ');
    await expectStatus(response, 200);
    expect(await response.json()).toEqual({
      data: {
        id: 'user-buyer',
        username: 'demo_user',
        displayName: '山田 みどり',
        role: 'buyer',
        roleLabel: '購入者',
        avatarInitial: '山',
        storeId: 'store-yamada',
        name: '山田 みどり',
      },
    });
    expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(
      previousSession,
    );
    expect(client.cookies.get('XSRF-TOKEN')).not.toBe(previousCsrf);
    expect(
      await setup.db.query(
        'SELECT session_id FROM hono_sessions WHERE session_id = ?',
        [previousSession],
      ),
    ).toEqual([]);
  });

  it.each([
    ['real legacy email', ' DEMO@MINETENANT.JP '],
    ['synthetic legacy email', syntheticEmailCandidate('user-buyer', 0)],
  ])(
    'accepts a stored %s during the compatibility period',
    async (kind, email) => {
      if (kind.startsWith('synthetic')) await prepareBuyer({ email });

      const response = await client.json('/api/v1/auth/login', 'POST', {
        email,
        password: 'password',
      });
      await expectStatus(response, 200);
      expect((await response.json()).data).toMatchObject({
        id: 'user-buyer',
        username: 'demo_user',
        displayName: '山田 みどり',
        name: '山田 みどり',
      });
    },
  );

  it('does not put credentials, hashes, or cookie values in bodies or logs', async () => {
    const password = 'unique-wrong-password';
    const [stored] = await setup.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE user_id = ?',
      ['user-buyer'],
    );
    const session = client.cookies.get(setup.config.sessionCookie)!;
    const csrf = decodeURIComponent(client.cookies.get('XSRF-TOKEN')!);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await usernameLogin(client, 'demo_user', password);
      await expectStatus(response, 401);
      const body = await response.text();
      expect(body).not.toContain(password);
      expect(body).not.toContain(stored!.password_hash);
      expect(body).not.toContain(session);
      expect(body).not.toContain(csrf);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('rejects mixed username and email without choosing either login path', async () => {
    const response = await client.json('/api/v1/auth/login', 'POST', {
      username: 'demo_user',
      email: 'demo@minetenant.jp',
      password: 'password',
    });
    await expectStatus(response, 422);
    expect(Object.keys((await response.json()).errors).sort()).toEqual([
      'email',
      'username',
    ]);
  });

  it('reports every missing or non-string canonical credential', async () => {
    const missing = await client.json('/api/v1/auth/login', 'POST', {});
    await expectStatus(missing, 422);
    expect(Object.keys((await missing.json()).errors).sort()).toEqual([
      'password',
      'username',
    ]);

    const wrongTypes = await client.json('/api/v1/auth/login', 'POST', {
      username: ['demo_user'],
      password: { value: 'password' },
    });
    await expectStatus(wrongTypes, 422);
    expect(Object.keys((await wrongTypes.json()).errors).sort()).toEqual([
      'password',
      'username',
    ]);
  });

  it('uses one form-level 401 for unknown users, wrong passwords, and corrupt hashes', async () => {
    const wrongPassword = await usernameLogin(
      client,
      'demo_user',
      'wrong-password',
    );
    const unknownUser = await usernameLogin(
      client,
      'unknown_user',
      'wrong-password',
    );
    await expectStatus(wrongPassword, 401);
    await expectStatus(unknownUser, 401);
    expect(await wrongPassword.json()).toEqual(invalidCredentials);
    expect(await unknownUser.json()).toEqual(invalidCredentials);

    const wrongLegacyPassword = await client.json(
      '/api/v1/auth/login',
      'POST',
      {
        email: 'demo@minetenant.jp',
        password: 'wrong-password',
      },
    );
    const unknownLegacyEmail = await client.json('/api/v1/auth/login', 'POST', {
      email: 'unknown@minetenant.jp',
      password: 'wrong-password',
    });
    await expectStatus(wrongLegacyPassword, 401);
    await expectStatus(unknownLegacyEmail, 401);
    expect(await wrongLegacyPassword.json()).toEqual(invalidCredentials);
    expect(await unknownLegacyEmail.json()).toEqual(invalidCredentials);

    await prepareBuyer({ passwordHash: 'not-a-bcrypt-hash' });
    const corruptHash = await usernameLogin(client);
    await expectStatus(corruptHash, 401);
    expect(await corruptHash.json()).toEqual(invalidCredentials);
  });

  it.each([
    ['seven characters', 'a'.repeat(7), 422],
    ['eight characters', 'password', 200],
    ['72 bytes', 'a'.repeat(72), 200],
    ['73 bytes', 'a'.repeat(73), 422],
    ['a NUL character', 'password\0hidden', 422],
  ] as const)(
    'applies the canonical password rules to legacy email: %s',
    async (_case, password, expectedStatus) => {
      if (expectedStatus === 200) {
        const passwordHash = await bcrypt.hash(password, 4);
        await prepareBuyer({ passwordHash, legacyPasswordHash: passwordHash });
      }
      const response = await client.json('/api/v1/auth/login', 'POST', {
        email: 'demo@minetenant.jp',
        password,
      });
      await expectStatus(response, expectedStatus);
      if (expectedStatus === 422)
        expect((await response.json()).errors.password).toBeDefined();
    },
  );

  it('requires JSON media types and accepts an application/*+json media type', async () => {
    const payload = JSON.stringify({
      username: 'demo_user',
      password: 'password',
    });
    const noJsonType = await client.request('/api/v1/auth/login', {
      method: 'POST',
      body: payload,
    });
    await expectStatus(noJsonType, 415);

    const form = await client.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=demo_user&password=password',
    });
    await expectStatus(form, 415);

    const malformed = await client.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    await expectStatus(malformed, 400);

    const vendorJson = await client.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.minetenant.login+json; charset=utf-8',
      },
      body: payload,
    });
    await expectStatus(vendorJson, 200);
  });

  it.each([
    ['real email', 'demo@minetenant.jp'],
    ['synthetic email', syntheticEmailCandidate('user-buyer', 0)],
  ])(
    'shares one five-attempt account bucket between username and %s',
    async (_kind, email) => {
      await prepareBuyer({ email });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response =
          attempt % 2 === 0
            ? await usernameLogin(client, ' DEMO_USER ', 'wrong-password')
            : await client.json('/api/v1/auth/login', 'POST', {
                email,
                password: 'wrong-password',
              });
        await expectStatus(response, 401);
      }

      const limited = await client.json('/api/v1/auth/login', 'POST', {
        email,
        password: 'password',
      });
      await expectStatus(limited, 429);
      expect(limited.headers.get('X-RateLimit-Limit')).toBe('5');
      expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(Number(limited.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(
        Math.floor(Date.now() / 1000),
      );
    },
  );

  it('rehashes a lower-cost canonical hash into both password columns', async () => {
    const lowCostHash = await bcrypt.hash('password', 4);
    await prepareBuyer({
      passwordHash: lowCostHash,
      legacyPasswordHash: lowCostHash,
    });
    const stronger = createClient(
      createApp({
        db: setup.db,
        config: { ...setup.config, bcryptRounds: 6 },
      }),
    );
    await expectStatus(await stronger.request('/api/v1/auth/csrf-cookie'), 204);

    await expectStatus(await usernameLogin(stronger), 200);
    const [updated] = await setup.db.query<{
      password: string;
      password_hash: string;
    }>('SELECT password, password_hash FROM users WHERE user_id = ?', [
      'user-buyer',
    ]);
    expect(updated!.password).toBe(updated!.password_hash);
    expect(updated!.password).not.toBe(lowCostHash);
    expect(bcrypt.getRounds(updated!.password)).toBe(6);
    expect(await bcrypt.compare('password', updated!.password)).toBe(true);
  });

  it('does not downgrade a stronger hash', async () => {
    const strongerHash = await bcrypt.hash('password', 6);
    await prepareBuyer({
      passwordHash: strongerHash,
      legacyPasswordHash: strongerHash,
    });

    await expectStatus(await usernameLogin(client), 200);
    const [unchanged] = await setup.db.query<{
      password: string;
      password_hash: string;
    }>('SELECT password, password_hash FROM users WHERE user_id = ?', [
      'user-buyer',
    ]);
    expect(unchanged).toEqual({
      password: strongerHash,
      password_hash: strongerHash,
    });
  });

  it('accepts a canonical $2y$ hash without exposing or rewriting it', async () => {
    const hash = (await bcrypt.hash('password', 4)).replace(/\$2b\$/, '$2y$');
    await prepareBuyer({ passwordHash: hash, legacyPasswordHash: hash });

    const response = await usernameLogin(client);
    await expectStatus(response, 200);
    expect(JSON.stringify(await response.json())).not.toContain(hash);
    const [stored] = await setup.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE user_id = ?',
      ['user-buyer'],
    );
    expect(stored!.password_hash).toBe(hash);
  });

  it('runs CSRF verification before media-type and JSON parsing errors', async () => {
    for (const request of [
      {
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      },
      {
        headers: { 'Content-Type': 'text/plain' },
        body: 'not-json',
      },
    ]) {
      await expectStatus(
        await setup.app.request('/api/v1/auth/login', {
          method: 'POST',
          ...request,
        }),
        419,
      );
      await expectStatus(
        await client.request('/api/v1/auth/login', {
          method: 'POST',
          ...request,
          headers: {
            ...request.headers,
            'X-XSRF-TOKEN': 'invalid-token',
          },
        }),
        419,
      );
    }
  });

  it('exposes all rate-limit headers to the configured frontend origin', async () => {
    const origin = 'http://localhost:5173';
    const expected = [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'Retry-After',
      'X-RateLimit-Reset',
    ];
    const preflight = await setup.app.request('/api/v1/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-xsrf-token',
      },
    });
    await expectStatus(preflight, 204);
    const preflightExposed = new Set(
      (preflight.headers.get('Access-Control-Expose-Headers') ?? '')
        .split(',')
        .map((header) => header.trim()),
    );
    for (const header of expected)
      expect(preflightExposed.has(header)).toBe(true);

    const response = await client.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: 'demo_user',
        password: 'wrong-password',
      }),
    });
    await expectStatus(response, 401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    const exposed = new Set(
      (response.headers.get('Access-Control-Expose-Headers') ?? '')
        .split(',')
        .map((header) => header.trim()),
    );
    for (const header of expected) expect(exposed.has(header)).toBe(true);
  });

  it('never stores a plaintext account identifier in rate-limit keys', async () => {
    await usernameLogin(client, 'demo_user', 'wrong-password');
    const rows = await setup.db.query<{ key_hash: string }>(
      'SELECT key_hash FROM hono_rate_limits',
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.key_hash).not.toContain('demo_user');
      expect(row.key_hash).not.toContain('wrong-password');
    }
    expect(
      rows.some(
        (row) =>
          row.key_hash ===
          createHash('sha256')
            .update('web-auth-account:username:demo_user|127.0.0.1')
            .digest('hex'),
      ),
    ).toBe(true);
  });
});
