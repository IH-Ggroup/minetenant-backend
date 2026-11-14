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
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
  type TestClient,
} from './helpers.js';

const password = 'registration-password';

describe('username registration', () => {
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

  it.each([
    ['specified', ' display_user ', '  山田 みどり  ', '山田 みどり'],
    ['omitted', 'omitted_user', undefined, 'omitted_user'],
    ['null', 'null_user', null, 'null_user'],
    ['Unicode whitespace', 'blank_user', '　 ', 'blank_user'],
  ] as const)(
    'normalizes the %s displayName case and writes only canonical auth columns',
    async (_case, rawUsername, displayName, expectedDisplayName) => {
      const originalSession = client.cookies.get(setup.config.sessionCookie)!;
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
      });

      const [user] = await setup.db.query<{
        username: string;
        display_name: string;
        password_hash: string;
        name: null;
        email: null;
        password: null;
        role_label: null;
        avatar_initial: null;
      }>(
        `SELECT username, display_name, password_hash, name, email, password,
                role_label, avatar_initial
           FROM users WHERE user_id = ?`,
        [data.id],
      );
      expect(user).toMatchObject({
        username: expectedUsername,
        display_name: expectedDisplayName,
        name: null,
        email: null,
        password: null,
        role_label: null,
        avatar_initial: null,
      });
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
    },
  );

  it('uses a full grapheme for the derived avatar initial', async () => {
    const response = await register(client, 'emoji_user', '👩‍💻 店主');
    await expectStatus(response, 201);
    expect((await response.json()).data.avatarInitial).toBe('👩‍💻');
  });

  it.each(['name', 'email', 'password_confirmation'] as const)(
    'rejects the removed %s field even with an otherwise valid request',
    async (field) => {
      const response = await client.json('/api/v1/auth/register', 'POST', {
        username: `removed_${field.replace('_', '')}`,
        password,
        [field]: 'removed-value',
      });
      await expectStatus(response, 422);
      expect(await response.json()).toEqual({
        message: 'この登録項目は利用できません。',
        errors: { [field]: ['この登録項目は利用できません。'] },
      });
    },
  );

  it('rejects a legacy-only request with every supplied removed field', async () => {
    const response = await client.json('/api/v1/auth/register', 'POST', {
      name: '旧利用者',
      email: 'old-user@example.com',
      password,
      password_confirmation: password,
    });
    await expectStatus(response, 422);
    expect(Object.keys((await response.json()).errors).sort()).toEqual(
      ['name', 'email', 'password_confirmation'].sort(),
    );
  });

  it.each(['demo', 'seller'])(
    'rejects the reserved system username %s',
    async (username) => {
      const response = await register(client, username);
      await expectStatus(response, 422);
      expect((await response.json()).errors).toHaveProperty('username');
    },
  );

  it('uses the canonical validator and requires JSON', async () => {
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
    expect(
      await setup.db.query('SELECT store_id FROM stores WHERE user_id = ?', [
        users[0]!.user_id,
      ]),
    ).toHaveLength(1);
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

  it('does not turn an unrelated unique-key failure into a username error', async () => {
    const collisionDb: Database = {
      ...setup.db,
      transaction: <T>(operation: (tx: SqlExecutor) => Promise<T>) =>
        setup.db.transaction((tx) =>
          operation({
            ...tx,
            execute: (sql, params) => {
              if (sql.startsWith('INSERT INTO stores')) {
                throw Object.assign(new Error('store collision'), {
                  code: 'ER_DUP_ENTRY',
                });
              }
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    const collisionClient = createClient(
      createApp({ db: collisionDb, config: setup.config }),
    );
    await expectStatus(
      await collisionClient.request('/api/v1/auth/csrf-cookie'),
      204,
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await register(collisionClient, 'collision_user');
      await expectStatus(response, 500);
      expect(await response.json()).toEqual({ message: 'Server Error' });
    } finally {
      logged.mockRestore();
    }
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
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await failingClient.json(
        '/api/v1/auth/register',
        'POST',
        { username: 'rollback_user', password },
      );
      await expectStatus(response, 500);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls.flat().join('\n')).not.toContain(password);
    } finally {
      logged.mockRestore();
    }
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
    expect(expected).not.toHaveProperty('name');
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
    expect(await login.json()).toEqual({ data: expected });
  });
});
