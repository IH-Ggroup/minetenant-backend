import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Database } from '../src/db.js';
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

interface StoredPasswords {
  password: string;
  password_hash: string;
}

function databaseWithConcurrentPasswordUpdate(
  base: Database,
  latestHash: string,
  source: 'password' | 'password_hash' = 'password_hash',
): { db: Database; casCalls: () => number } {
  let casCalls = 0;
  const db: Database = {
    query: (sql, params) => base.query(sql, params),
    async execute(sql, params) {
      if (sql.includes(`AND BINARY ${source} = BINARY ?`) && casCalls === 0) {
        casCalls += 1;
        await base.execute(
          `UPDATE users
              SET password = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?`,
          [latestHash, latestHash, 'user-buyer'],
        );
        return { affectedRows: 0 };
      }
      return base.execute(sql, params);
    },
    withConnection: (fn) => base.withConnection(fn),
    transaction: (fn) => base.transaction(fn),
    close: () => base.close(),
  };
  return { db, casCalls: () => casCalls };
}

describe('login password rehash compare-and-swap races', () => {
  let setup: TestApp;

  beforeAll(async () => {
    setup = await createTestApp({
      bcryptRounds: 6,
      usernameAuthEnabled: true,
    });
  });

  beforeEach(async () => {
    await setup.reset();
  });

  afterAll(async () => {
    await setup?.close();
  });

  async function prepareCanonicalBuyer(): Promise<void> {
    const staleHash = await bcrypt.hash('password', 4);
    await setup.db.execute(
      `UPDATE users
          SET username = ?, display_name = ?, password = ?, password_hash = ?
        WHERE user_id = ?`,
      ['demo_user', '山田 みどり', staleHash, staleHash, 'user-buyer'],
    );
  }

  async function clientForRace(
    latestHash: string,
    usernameAuthEnabled = true,
  ): Promise<{
    client: TestClient;
    casCalls: () => number;
  }> {
    const race = databaseWithConcurrentPasswordUpdate(
      setup.db,
      latestHash,
      usernameAuthEnabled ? 'password_hash' : 'password',
    );
    const client = createClient(
      createApp({
        db: race.db,
        config: { ...setup.config, usernameAuthEnabled },
      }),
    );
    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);
    return { client, casCalls: race.casCalls };
  }

  async function login(
    client: TestClient,
    usernameAuthEnabled = true,
  ): Promise<Response> {
    return client.json('/api/v1/auth/login', 'POST', {
      ...(usernameAuthEnabled
        ? { username: 'demo_user' }
        : { email: 'demo@minetenant.jp' }),
      password: 'password',
    });
  }

  async function storedPasswords(): Promise<StoredPasswords> {
    const [stored] = await setup.db.query<StoredPasswords>(
      'SELECT password, password_hash FROM users WHERE user_id = ?',
      ['user-buyer'],
    );
    return stored!;
  }

  it('accepts the current hash when a concurrent update kept the same password', async () => {
    await prepareCanonicalBuyer();
    const concurrentHash = await bcrypt.hash('password', 8);
    const { client, casCalls } = await clientForRace(concurrentHash);
    const anonymousSession = client.cookies.get(setup.config.sessionCookie)!;

    const response = await login(client);

    await expectStatus(response, 200);
    expect(casCalls()).toBe(1);
    expect(await storedPasswords()).toEqual({
      password: concurrentHash,
      password_hash: concurrentHash,
    });
    const authenticatedSession = client.cookies.get(
      setup.config.sessionCookie,
    )!;
    expect(authenticatedSession).not.toBe(anonymousSession);
    expect(
      await setup.db.query(
        'SELECT session_id FROM hono_sessions WHERE session_id = ?',
        [anonymousSession],
      ),
    ).toEqual([]);
    expect(
      await setup.db.query<{ user_id: string | null }>(
        'SELECT user_id FROM hono_sessions WHERE session_id = ?',
        [authenticatedSession],
      ),
    ).toEqual([{ user_id: 'user-buyer' }]);
  });

  it('rejects the stale password when a concurrent update changed it', async () => {
    await prepareCanonicalBuyer();
    const concurrentHash = await bcrypt.hash('new-password', 8);
    const { client, casCalls } = await clientForRace(concurrentHash);
    const anonymousSession = client.cookies.get(setup.config.sessionCookie)!;

    const response = await login(client);

    await expectStatus(response, 401);
    expect(await response.json()).toEqual(invalidCredentials);
    expect(casCalls()).toBe(1);
    expect(await storedPasswords()).toEqual({
      password: concurrentHash,
      password_hash: concurrentHash,
    });
    expect(client.cookies.get(setup.config.sessionCookie)).toBe(
      anonymousSession,
    );
    expect(
      await setup.db.query<{ user_id: string | null }>(
        'SELECT user_id FROM hono_sessions WHERE session_id = ?',
        [anonymousSession],
      ),
    ).toEqual([{ user_id: null }]);
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
  });

  it('uses the same CAS protection for the legacy password source', async () => {
    await prepareCanonicalBuyer();
    const concurrentHash = await bcrypt.hash('password', 8);
    const { client, casCalls } = await clientForRace(concurrentHash, false);
    const anonymousSession = client.cookies.get(setup.config.sessionCookie)!;

    const response = await login(client, false);

    await expectStatus(response, 200);
    expect(casCalls()).toBe(1);
    expect(await storedPasswords()).toEqual({
      password: concurrentHash,
      password_hash: concurrentHash,
    });
    expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(
      anonymousSession,
    );
  });

  it('does not authenticate a stale legacy password after a concurrent change', async () => {
    await prepareCanonicalBuyer();
    const concurrentHash = await bcrypt.hash('new-password', 8);
    const { client, casCalls } = await clientForRace(concurrentHash, false);
    const anonymousSession = client.cookies.get(setup.config.sessionCookie)!;

    const response = await login(client, false);

    await expectStatus(response, 422);
    expect((await response.json()).errors).toEqual({
      email: ['メールアドレスまたはパスワードが正しくありません。'],
    });
    expect(casCalls()).toBe(1);
    expect(await storedPasswords()).toEqual({
      password: concurrentHash,
      password_hash: concurrentHash,
    });
    expect(client.cookies.get(setup.config.sessionCookie)).toBe(
      anonymousSession,
    );
    await expectStatus(await client.request('/api/v1/auth/me'), 401);
  });
});
