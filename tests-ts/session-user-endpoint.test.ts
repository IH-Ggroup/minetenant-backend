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
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
  type TestClient,
} from './helpers.js';

describe('session user endpoint cutover gate', () => {
  let setup: TestApp;
  let client: TestClient;
  let passwordHash: string;

  beforeAll(async () => {
    setup = await createTestApp({ usernameAuthEnabled: true });
  });

  beforeEach(async () => {
    await setup.reset();
    passwordHash = await prepareBuyer();
    client = createClient(setup.app);
    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);
  });

  afterAll(async () => {
    await setup?.close();
  });

  async function prepareBuyer(): Promise<string> {
    const [seeded] = await setup.db.query<{ password: string }>(
      'SELECT password FROM users WHERE user_id = ?',
      ['user-buyer'],
    );
    const passwordHash = seeded!.password;
    await setup.db.execute(
      `UPDATE users
          SET username = ?, display_name = ?, password_hash = ?
        WHERE user_id = ?`,
      ['demo_user', '山田 みどり', passwordHash, 'user-buyer'],
    );
    return passwordHash;
  }

  async function loginWithUsername(
    target: TestClient,
    username = 'demo_user',
  ): Promise<void> {
    await expectStatus(
      await target.json('/api/v1/auth/login', 'POST', {
        username,
        password: 'password',
      }),
      200,
    );
  }

  it('keeps the exact legacy response while the gate is false', async () => {
    const legacy = createClient(
      createApp({
        db: setup.db,
        config: { ...setup.config, usernameAuthEnabled: false },
      }),
    );
    await expectStatus(await legacy.request('/api/v1/auth/csrf-cookie'), 204);
    await expectStatus(await legacy.login(), 200);

    const response = await legacy.request('/api/v1/auth/me');
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

  it('loads the current user by the session userId and returns the transitional response', async () => {
    await loginWithUsername(client);
    await setup.db.execute(
      'UPDATE users SET display_name = ? WHERE user_id = ?',
      ['更新後の表示名', 'user-buyer'],
    );

    const response = await client.request('/api/v1/auth/me?userId=user-seller');
    await expectStatus(response, 200);
    expect(await response.json()).toEqual({
      data: {
        id: 'user-buyer',
        username: 'demo_user',
        displayName: '更新後の表示名',
        role: 'buyer',
        roleLabel: '購入者',
        avatarInitial: '更',
        storeId: 'store-yamada',
        name: '更新後の表示名',
      },
    });
  });

  it('returns a null storeId for an authenticated user without a store', async () => {
    await setup.db.execute(
      `INSERT INTO users
        (user_id, username, display_name, password_hash, role)
       VALUES (?, ?, ?, ?, ?)`,
      [
        'user-without-store',
        'standalone_user',
        '店舗なし利用者',
        passwordHash,
        'seller',
      ],
    );
    await loginWithUsername(client, 'standalone_user');

    const response = await client.request('/api/v1/auth/me');
    await expectStatus(response, 200);
    expect(await response.json()).toEqual({
      data: {
        id: 'user-without-store',
        username: 'standalone_user',
        displayName: '店舗なし利用者',
        role: 'seller',
        roleLabel: '出品者',
        avatarInitial: '店',
        storeId: null,
        name: '店舗なし利用者',
      },
    });
  });

  it('returns the existing 401 response without creating a session', async () => {
    const anonymous = await setup.app.request('/api/v1/auth/me');

    await expectStatus(anonymous, 401);
    expect(await anonymous.json()).toEqual({ message: 'Unauthenticated.' });
    expect(anonymous.headers.getSetCookie()).toHaveLength(0);
  });

  it('fails closed without exposing user, credential, or session values', async () => {
    await loginWithUsername(client);
    const sessionId = client.cookies.get(setup.config.sessionCookie)!;
    const csrfToken = decodeURIComponent(client.cookies.get('XSRF-TOKEN')!);
    await setup.db.execute(
      'UPDATE users SET display_name = NULL WHERE user_id = ?',
      ['user-buyer'],
    );

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await client.request('/api/v1/auth/me');
      await expectStatus(response, 500);
      const body = await response.text();
      const logs = JSON.stringify(logged.mock.calls);

      expect(JSON.parse(body)).toEqual({ message: 'Server Error' });
      expect(logged).toHaveBeenCalledOnce();
      for (const secret of [
        'demo_user',
        'demo@minetenant.jp',
        passwordHash,
        sessionId,
        csrfToken,
      ]) {
        expect(body).not.toContain(secret);
        expect(logs).not.toContain(secret);
      }
    } finally {
      logged.mockRestore();
    }
  });
});
