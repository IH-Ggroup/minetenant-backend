import bcrypt from 'bcryptjs';
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
import type { Database, SqlExecutor } from '../src/db.js';
import {
  syntheticEmailCandidate,
  usernameCandidate,
} from '../src/db/auth-backfill.js';
import {
  createRegistration,
  RegistrationIdentifierAllocationError,
} from '../src/services/registration.js';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
  type TestClient,
} from './helpers.js';

const password = 'registration-password';

describe('username registration cutover gate', () => {
  let setup: TestApp;
  let client: TestClient;

  beforeAll(async () => {
    setup = await createTestApp({ usernameAuthEnabled: true });
  });

  beforeEach(async () => {
    await setup.reset();
    client = createClient(setup.app);
    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);
  });

  afterAll(async () => {
    await setup?.close();
  });

  function register(
    target: TestClient,
    username: string,
    displayName: string | null | undefined = undefined,
  ) {
    return target.json('/api/v1/auth/register', 'POST', {
      username,
      ...(displayName === undefined ? {} : { displayName }),
      password,
      passwordConfirmation: password,
    });
  }

  it('keeps the legacy request and response while the gate is false', async () => {
    const legacy = createClient(
      createApp({
        db: setup.db,
        config: { ...setup.config, usernameAuthEnabled: false },
      }),
    );
    await expectStatus(await legacy.request('/api/v1/auth/csrf-cookie'), 204);

    const rejected = await register(legacy, 'new_user');
    await expectStatus(rejected, 422);
    expect(Object.keys((await rejected.json()).errors).sort()).toEqual([
      'email',
      'name',
    ]);

    const response = await legacy.json('/api/v1/auth/register', 'POST', {
      name: ' 旧 利用者 ',
      email: ' LEGACY@EXAMPLE.COM ',
      password,
    });
    await expectStatus(response, 201);
    const { data } = await response.json();
    expect(data).toMatchObject({
      name: '旧 利用者',
      role: 'buyer',
      roleLabel: '購入者',
      avatarInitial: '旧',
    });
    expect(Object.keys(data).sort()).toEqual(
      ['avatarInitial', 'id', 'name', 'role', 'roleLabel', 'storeId'].sort(),
    );
    const [stored] = await setup.db.query<{
      email: string;
      username: string | null;
      display_name: string | null;
      password_hash: string | null;
    }>(
      'SELECT email, username, display_name, password_hash FROM users WHERE user_id = ?',
      [data.id],
    );
    expect(stored).toEqual({
      email: 'legacy@example.com',
      username: null,
      display_name: null,
      password_hash: null,
    });
  });

  it.each([
    ['specified', ' display_user ', '  山田 みどり  ', '山田 みどり'],
    ['omitted', 'omitted_user', undefined, 'omitted_user'],
    ['null', 'null_user', null, 'null_user'],
    ['Unicode whitespace', 'blank_user', '　 ', 'blank_user'],
  ] as const)(
    'normalizes the %s displayName case and creates one compatible user/store',
    async (_case, rawUsername, displayName, expectedDisplayName) => {
      const originalSession = client.cookies.get(setup.config.sessionCookie)!;
      const originalCsrf = client.cookies.get('XSRF-TOKEN')!;
      const response = await register(client, rawUsername, displayName);
      await expectStatus(response, 201);
      const { data } = await response.json();
      const expectedUsername = rawUsername.trim();
      expect(data).toEqual({
        id: expect.any(String),
        username: expectedUsername,
        displayName: expectedDisplayName,
        role: 'buyer',
        roleLabel: '購入者',
        avatarInitial: Array.from(expectedDisplayName)[0],
        storeId: expect.any(String),
        name: expectedDisplayName,
      });

      const [user] = await setup.db.query<{
        username: string;
        display_name: string;
        password_hash: string;
        name: string;
        email: string;
        password: string;
        role: string;
        role_label: string;
        avatar_initial: string;
      }>(
        `SELECT username, display_name, password_hash, name, email, password,
                role, role_label, avatar_initial
           FROM users WHERE user_id = ?`,
        [data.id],
      );
      expect(user).toMatchObject({
        username: expectedUsername,
        display_name: expectedDisplayName,
        name: expectedDisplayName,
        email: syntheticEmailCandidate(data.id, 0),
        role: 'buyer',
        role_label: '購入者',
        avatar_initial: Array.from(expectedDisplayName)[0],
      });
      expect(user!.password).toBe(user!.password_hash);
      expect(user!.password).not.toBe(password);
      expect(await bcrypt.compare(password, user!.password_hash)).toBe(true);

      const [store] = await setup.db.query<{
        user_id: string;
        name: string;
        description: string;
        level: number;
        points: number;
        sync_status: string;
      }>(
        `SELECT user_id, name, description, level, points, sync_status
           FROM stores WHERE store_id = ?`,
        [data.storeId],
      );
      expect(store).toEqual({
        user_id: data.id,
        name: `${expectedDisplayName}の店舗`,
        description: '',
        level: 1,
        points: 0,
        sync_status: 'offline',
      });
      expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(
        originalSession,
      );
      expect(client.cookies.get('XSRF-TOKEN')).not.toBe(originalCsrf);
      expect(
        await setup.db.query(
          'SELECT session_id FROM hono_sessions WHERE session_id = ?',
          [originalSession],
        ),
      ).toEqual([]);
    },
  );

  it('uses a grapheme in the DTO and one code point in the legacy column', async () => {
    const response = await register(client, 'emoji_user', '👩‍💻 店主');
    await expectStatus(response, 201);
    const { data } = await response.json();
    expect(data.avatarInitial).toBe('👩‍💻');
    const [user] = await setup.db.query<{ avatar_initial: string }>(
      'SELECT avatar_initial FROM users WHERE user_id = ?',
      [data.id],
    );
    expect(user!.avatar_initial).toBe('👩');
  });

  it('accepts the temporary legacy request and dual-writes canonical columns', async () => {
    const response = await client.json('/api/v1/auth/register', 'POST', {
      name: ' \u200b旧 利用者\u200b ',
      email: ' OLD-USER@EXAMPLE.COM ',
      password,
      password_confirmation: password,
    });
    await expectStatus(response, 201);
    const { data } = await response.json();
    expect(data).toEqual({
      id: expect.any(String),
      username: usernameCandidate(data.id, 0),
      displayName: '旧 利用者',
      role: 'buyer',
      roleLabel: '購入者',
      avatarInitial: '旧',
      storeId: expect.any(String),
      name: '旧 利用者',
    });
    const [user] = await setup.db.query<{
      name: string;
      email: string;
      password: string;
      username: string;
      display_name: string;
      password_hash: string;
    }>(
      `SELECT name, email, password, username, display_name, password_hash
         FROM users WHERE user_id = ?`,
      [data.id],
    );
    expect(user).toMatchObject({
      name: '旧 利用者',
      email: 'old-user@example.com',
      username: usernameCandidate(data.id, 0),
      display_name: '旧 利用者',
    });
    expect(user!.password).toBe(user!.password_hash);
  });

  it.each(['demo', 'seller'])(
    'rejects the reserved system username %s',
    async (username) => {
      const response = await register(client, username);
      await expectStatus(response, 422);
      expect((await response.json()).errors).toHaveProperty('username');
    },
  );

  it('rejects the synthetic email namespace after cutover', async () => {
    const response = await client.json('/api/v1/auth/register', 'POST', {
      name: '予約領域',
      email: syntheticEmailCandidate('reserved-email', 0),
      password,
    });
    await expectStatus(response, 422);
    expect((await response.json()).errors.email).toEqual([
      'このメールアドレスは使用できません。',
    ]);
  });

  it('rejects every supplied new and legacy field in a mixed request', async () => {
    const response = await client.json('/api/v1/auth/register', 'POST', {
      username: 'mixed_user',
      displayName: null,
      passwordConfirmation: password,
      name: '混在',
      email: 'mixed@example.com',
      password_confirmation: password,
      password,
    });
    await expectStatus(response, 422);
    expect(Object.keys((await response.json()).errors).sort()).toEqual(
      [
        'username',
        'displayName',
        'passwordConfirmation',
        'name',
        'email',
        'password_confirmation',
      ].sort(),
    );
  });

  it('uses the canonical validator and requires JSON after cutover', async () => {
    const invalid = await client.json('/api/v1/auth/register', 'POST', {
      username: 'ab',
      displayName: 42,
      password: 'short',
      passwordConfirmation: 'different',
    });
    await expectStatus(invalid, 422);
    expect(Object.keys((await invalid.json()).errors).sort()).toEqual(
      ['displayName', 'password', 'passwordConfirmation', 'username'].sort(),
    );

    const form = await client.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=form_user&password=${password}`,
    });
    await expectStatus(form, 415);
  });

  it('checks CSRF before parsing or writing registration data', async () => {
    const anonymous = createClient(setup.app);
    const response = await anonymous.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'not-json' },
      body: 'username=csrf_user',
    });
    await expectStatus(response, 419);
    expect(
      await setup.db.query('SELECT user_id FROM users WHERE username = ?', [
        'csrf_user',
      ]),
    ).toEqual([]);
  });

  it('lets exactly one concurrent registration own a normalized username', async () => {
    const second = createClient(setup.app);
    await expectStatus(await second.request('/api/v1/auth/csrf-cookie'), 204);
    const responses = await Promise.all([
      register(client, ' Race_User ', '先着'),
      register(second, 'race_user', '後着'),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 422]);
    const rejected = responses.find(({ status }) => status === 422)!;
    expect((await rejected.json()).errors.username).toEqual([
      'このユーザー名は既に登録されています。',
    ]);
    const users = await setup.db.query<{ user_id: string }>(
      'SELECT user_id FROM users WHERE username = ?',
      ['race_user'],
    );
    expect(users).toHaveLength(1);
    const stores = await setup.db.query<{ store_id: string }>(
      'SELECT store_id FROM stores WHERE user_id = ?',
      [users[0]!.user_id],
    );
    expect(stores).toHaveLength(1);
  });

  it('allows only one registration to rotate the same browser session without reissuing loser cookies', async () => {
    const originalSession = client.cookies.get(setup.config.sessionCookie)!;
    const responses = await Promise.all([
      register(client, 'double_submit_a', '二重送信A'),
      register(client, 'double_submit_b', '二重送信B'),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 419]);
    const succeeded = responses.find(({ status }) => status === 201)!;
    const expected = (await succeeded.json()).data;
    const rejected = responses.find(({ status }) => status === 419)!;
    expect(await rejected.json()).toEqual({ message: 'CSRF token mismatch.' });
    expect(rejected.headers.getSetCookie()).toHaveLength(0);

    const users = await setup.db.query<{ user_id: string }>(
      `SELECT user_id FROM users
        WHERE username IN ('double_submit_a', 'double_submit_b')`,
    );
    expect(users).toEqual([{ user_id: expected.id }]);
    expect(
      await setup.db.query('SELECT store_id FROM stores WHERE user_id = ?', [
        expected.id,
      ]),
    ).toHaveLength(1);
    expect(
      await setup.db.query(
        'SELECT session_id FROM hono_sessions WHERE session_id = ?',
        [originalSession],
      ),
    ).toEqual([]);
    expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(
      originalSession,
    );
    const me = await client.request('/api/v1/auth/me');
    await expectStatus(me, 200);
    expect(await me.json()).toEqual({ data: expected });
  });

  it('keeps ordinary login rotation non-exclusive for the same browser session', async () => {
    await expectStatus(await register(client, 'parallel_login_user'), 201);
    await expectStatus(await client.json('/api/v1/auth/logout', 'POST'), 204);
    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);

    const responses = await Promise.all([
      client.json('/api/v1/auth/login', 'POST', {
        username: 'parallel_login_user',
        password,
      }),
      client.json('/api/v1/auth/login', 'POST', {
        username: 'parallel_login_user',
        password,
      }),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(
      responses.every((response) => response.headers.has('Set-Cookie')),
    ).toBe(true);
    await expectStatus(await client.request('/api/v1/auth/me'), 200);
  });

  it('returns the same username error for an existing normalized username', async () => {
    await expectStatus(await register(client, 'duplicate_user'), 201);
    const second = createClient(setup.app);
    await expectStatus(await second.request('/api/v1/auth/csrf-cookie'), 204);
    const duplicate = await register(second, ' DUPLICATE_USER ');
    await expectStatus(duplicate, 422);
    expect(await duplicate.json()).toEqual({
      message: 'このユーザー名は既に登録されています。',
      errors: {
        username: ['このユーザー名は既に登録されています。'],
      },
    });
  });

  it('retries an internal synthetic email collision deterministically', async () => {
    const userId = 'registration-candidate-user';
    const passwordHash = await bcrypt.hash(password, 4);
    await setup.db.execute(
      `INSERT INTO users
        (user_id, username, display_name, password_hash, name, email, password,
         role, role_label, avatar_initial, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'buyer', '購入者', '競', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        'synthetic-email-owner',
        'synthetic_owner',
        '競合所有者',
        passwordHash,
        '競合所有者',
        syntheticEmailCandidate(userId, 0),
        passwordHash,
      ],
    );

    const user = await createRegistration(
      setup.db,
      {
        kind: 'username',
        userId,
        storeId: 'registration-candidate-store',
        username: 'candidate_user',
        displayName: '候補利用者',
        passwordHash,
      },
      (_registeredUserId, operation) => setup.db.transaction(operation),
    );
    const [stored] = await setup.db.query<{ email: string }>(
      'SELECT email FROM users WHERE user_id = ?',
      [user.user_id],
    );
    expect(stored!.email).toBe(syntheticEmailCandidate(userId, 1));
  });

  it('retries an internal legacy username collision deterministically', async () => {
    const userId = 'legacy-candidate-user';
    const passwordHash = await bcrypt.hash(password, 4);
    await setup.db.execute(
      `INSERT INTO users
        (user_id, username, display_name, password_hash, name, email, password,
         role, role_label, avatar_initial, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'buyer', '購入者', '競', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        'generated-username-owner',
        usernameCandidate(userId, 0),
        '競合所有者',
        passwordHash,
        '競合所有者',
        'generated-owner@example.com',
        passwordHash,
      ],
    );

    const user = await createRegistration(
      setup.db,
      {
        kind: 'legacy',
        userId,
        storeId: 'legacy-candidate-store',
        name: '旧候補利用者',
        email: 'legacy-candidate@example.com',
        passwordHash,
      },
      (_registeredUserId, operation) => setup.db.transaction(operation),
    );
    expect(user.username).toBe(usernameCandidate(userId, 1));
  });

  it('fails safely after all compatibility identifiers are occupied', async () => {
    let attempts = 0;
    const collisionDb: Database = {
      ...setup.db,
      async query<T extends object>(sql: string): Promise<T[]> {
        if (sql.includes('WHERE username =')) return [];
        if (sql.includes('WHERE email ='))
          return [{ user_id: 'occupied' }] as T[];
        return [];
      },
    };
    const passwordHash = await bcrypt.hash(password, 4);
    const result = createRegistration(
      collisionDb,
      {
        kind: 'username',
        userId: 'exhausted-user',
        storeId: 'exhausted-store',
        username: 'exhausted_user',
        displayName: '枯渇確認',
        passwordHash,
      },
      async () => {
        attempts += 1;
        throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      },
    );
    await expect(result).rejects.toBeInstanceOf(
      RegistrationIdentifierAllocationError,
    );
    expect(attempts).toBe(100);
  });

  it('rolls back user, store, and session rotation when session creation fails', async () => {
    const failingDb: Database = {
      ...setup.db,
      transaction: <T>(operation: (tx: SqlExecutor) => Promise<T>) =>
        setup.db.transaction((tx) =>
          operation({
            ...tx,
            execute: (sql, params) => {
              if (
                sql.startsWith('INSERT INTO hono_sessions') &&
                typeof params?.[1] === 'string'
              ) {
                throw new Error('injected session failure');
              }
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    const failingClient = createClient(
      createApp({ db: failingDb, config: setup.config }),
    );
    await expectStatus(
      await failingClient.request('/api/v1/auth/csrf-cookie'),
      204,
    );
    const anonymousSession = failingClient.cookies.get(
      setup.config.sessionCookie,
    )!;
    const secret = 'rollback-secret-password';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await failingClient.json(
        '/api/v1/auth/register',
        'POST',
        {
          username: 'rollback_user',
          password: secret,
        },
      );
      await expectStatus(response, 500);
      expect(await response.json()).toEqual({ message: 'Server Error' });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls.flat().join('\n')).not.toContain(secret);
    } finally {
      logged.mockRestore();
    }
    expect(failingClient.cookies.get(setup.config.sessionCookie)).toBe(
      anonymousSession,
    );
    expect(
      await setup.db.query('SELECT user_id FROM users WHERE username = ?', [
        'rollback_user',
      ]),
    ).toEqual([]);
    expect(
      await setup.db.query('SELECT store_id FROM stores WHERE name = ?', [
        'rollback_userの店舗',
      ]),
    ).toEqual([]);
    expect(
      await setup.db.query(
        'SELECT session_id FROM hono_sessions WHERE session_id = ?',
        [anonymousSession],
      ),
    ).toHaveLength(1);
  });

  it('shares the canonical account rate limit with username login', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expectStatus(
        await client.json('/api/v1/auth/login', 'POST', {
          username: ' LIMITED_USER ',
          password: 'wrong-password',
        }),
        401,
      );
    }
    await expectStatus(await register(client, 'limited_user'), 201);
    const limited = await register(client, 'limited_user');
    await expectStatus(limited, 429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('supports register, me, logout, and username login as one lifecycle', async () => {
    const registered = await register(client, 'lifecycle_user', '連携 利用者');
    await expectStatus(registered, 201);
    const expected = (await registered.json()).data;
    expect(JSON.stringify(expected)).not.toContain(password);
    expect(expected).not.toHaveProperty('email');

    const me = await client.request('/api/v1/auth/me');
    await expectStatus(me, 200);
    expect(await me.json()).toEqual({ data: expected });
    await expectStatus(await client.json('/api/v1/auth/logout', 'POST'), 204);
    await expectStatus(await client.request('/api/v1/auth/me'), 401);

    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);
    const login = await client.json('/api/v1/auth/login', 'POST', {
      username: ' LIFECYCLE_USER ',
      password,
    });
    await expectStatus(login, 200);
    const loginExpected = { ...expected };
    delete loginExpected.name;
    expect(await login.json()).toEqual({ data: loginExpected });
  });
});
