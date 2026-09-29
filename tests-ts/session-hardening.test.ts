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
import { createDatabase, type Database, type SqlExecutor } from '../src/db.js';
import type { AppEnv } from '../src/types.js';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
} from './helpers.js';

const allowedOrigin = 'http://localhost:5173';

function bindings(remoteAddress: string): AppEnv['Bindings'] {
  return {
    incoming: { socket: { remoteAddress } },
  } as AppEnv['Bindings'];
}

describe('lazy anonymous sessions', () => {
  let setup: TestApp;

  beforeAll(async () => {
    setup = await createTestApp();
  });
  beforeEach(async () => {
    await setup.reset();
  });
  afterAll(async () => {
    await setup?.close();
  });

  async function sessionCount(): Promise<number> {
    const [row] = await setup.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM hono_sessions',
    );
    return Number(row?.count ?? 0);
  }

  it('does not create sessions for non-bootstrap request boundaries', async () => {
    for (let request = 0; request < 12; request++) {
      const response = await setup.app.request('/api/v1/products');
      await expectStatus(response, 200);
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }

    const cases: [string, RequestInit, number][] = [
      ['/api/v1/products', { method: 'HEAD' }, 200],
      ['/api/v1/auth/csrf-cookie', { method: 'HEAD' }, 204],
      ['/api/v1/auth/me', {}, 401],
      [
        '/api/v1/auth/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'demo@minetenant.jp' }),
        },
        419,
      ],
      ['/api/v1/missing', {}, 404],
      [
        '/api/v1/products',
        {
          method: 'OPTIONS',
          headers: {
            Origin: allowedOrigin,
            'Access-Control-Request-Method': 'POST',
          },
        },
        204,
      ],
      ['/api/v1/minecraft/catalog', {}, 200],
      [
        '/api/v1/minecraft/purchases',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
        422,
      ],
    ];
    for (const [path, init, status] of cases) {
      const response = await setup.app.request(path, init);
      await expectStatus(response, status);
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
    expect(await sessionCount()).toBe(0);
  });

  it('creates once, extends the same session and preserves authentication without consuming another creation', async () => {
    const client = createClient(setup.app);
    const first = await client.request('/api/v1/auth/csrf-cookie');
    await expectStatus(first, 204);
    expect(first.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(first.headers.get('X-RateLimit-Remaining')).toBe('9');
    const anonymousId = client.cookies.get(setup.config.sessionCookie)!;
    expect(await sessionCount()).toBe(1);
    const [bucket] = await setup.db.query<{
      key_hash: string;
      hits: number;
    }>('SELECT key_hash, hits FROM hono_rate_limits');
    expect(Number(bucket?.hits)).toBe(1);

    const shortenedExpiry = Date.now() + 10_000;
    await setup.db.execute(
      'UPDATE hono_sessions SET expires_at = ? WHERE session_id = ?',
      [shortenedExpiry, anonymousId],
    );
    const reused = await client.request('/api/v1/auth/csrf-cookie');
    await expectStatus(reused, 204);
    expect(reused.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(reused.headers.get('X-RateLimit-Remaining')).toBe('9');
    expect(client.cookies.get(setup.config.sessionCookie)).toBe(anonymousId);
    const [extended] = await setup.db.query<{ expires_at: number }>(
      'SELECT expires_at FROM hono_sessions WHERE session_id = ?',
      [anonymousId],
    );
    expect(Number(extended?.expires_at)).toBeGreaterThan(shortenedExpiry);
    const [unchangedBucket] = await setup.db.query<{ hits: number }>(
      'SELECT hits FROM hono_rate_limits WHERE key_hash = ?',
      [bucket!.key_hash],
    );
    expect(Number(unchangedBucket?.hits)).toBe(1);

    const separate = await setup.app.request('/api/v1/auth/csrf-cookie');
    await expectStatus(separate, 204);
    expect(await sessionCount()).toBe(2);
    const [consumedBucket] = await setup.db.query<{ hits: number }>(
      'SELECT hits FROM hono_rate_limits WHERE key_hash = ?',
      [bucket!.key_hash],
    );
    expect(Number(consumedBucket?.hits)).toBe(2);

    await expectStatus(await client.login(), 200);
    const authenticatedId = client.cookies.get(setup.config.sessionCookie)!;
    expect(authenticatedId).not.toBe(anonymousId);
    const authenticatedBootstrap = await client.request(
      '/api/v1/auth/csrf-cookie',
    );
    await expectStatus(authenticatedBootstrap, 204);
    expect(authenticatedBootstrap.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(authenticatedBootstrap.headers.get('X-RateLimit-Remaining')).toBe(
      '8',
    );
    expect(client.cookies.get(setup.config.sessionCookie)).toBe(
      authenticatedId,
    );
    const [authenticated] = await setup.db.query<{ user_id: string | null }>(
      'SELECT user_id FROM hono_sessions WHERE session_id = ?',
      [authenticatedId],
    );
    expect(authenticated?.user_id).toBe('user-buyer');
    await expectStatus(await client.request('/api/v1/auth/me'), 200);
    const [stillUnchanged] = await setup.db.query<{ hits: number }>(
      'SELECT hits FROM hono_rate_limits WHERE key_hash = ?',
      [bucket!.key_hash],
    );
    expect(Number(stillUnchanged?.hits)).toBe(2);
  });

  it('replaces invalid or expired cookies only at CSRF bootstrap', async () => {
    const invalidCookie = `${setup.config.sessionCookie}=${'f'.repeat(64)}`;
    for (const [path, status] of [
      ['/api/v1/products', 200],
      ['/api/v1/auth/me', 401],
    ] as const) {
      const response = await setup.app.request(path, {
        headers: { Cookie: invalidCookie },
      });
      await expectStatus(response, status);
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
    expect(await sessionCount()).toBe(0);

    const client = createClient(setup.app);
    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);
    const expiredId = client.cookies.get(setup.config.sessionCookie)!;
    await setup.db.execute(
      'UPDATE hono_sessions SET expires_at = ? WHERE session_id = ?',
      [Date.now() - 1, expiredId],
    );
    const rejected = await client.request('/api/v1/auth/me');
    await expectStatus(rejected, 401);
    expect(rejected.headers.getSetCookie()).toHaveLength(0);
    expect(client.cookies.get(setup.config.sessionCookie)).toBe(expiredId);
    expect(
      await setup.db.query(
        'SELECT session_id FROM hono_sessions WHERE expires_at > ?',
        [Date.now()],
      ),
    ).toEqual([]);

    const replacement = await client.request('/api/v1/auth/csrf-cookie');
    await expectStatus(replacement, 204);
    expect(replacement.headers.getSetCookie()).toHaveLength(2);
    expect(client.cookies.get(setup.config.sessionCookie)).not.toBe(expiredId);
    expect(
      await setup.db.query(
        'SELECT session_id FROM hono_sessions WHERE expires_at > ?',
        [Date.now()],
      ),
    ).toHaveLength(1);
  });

  it('atomically limits concurrent creation across app instances and isolates IP buckets', async () => {
    const secondDb = createDatabase(setup.config);
    const secondApp = createApp({ db: secondDb, config: setup.config });
    try {
      const limitedIp = '203.0.113.42';
      const responses = await Promise.all(
        Array.from({ length: 11 }, (_, index) =>
          (index % 2 === 0 ? setup.app : secondApp).request(
            '/api/v1/auth/csrf-cookie',
            { headers: { Origin: allowedOrigin } },
            bindings(limitedIp),
          ),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([
        204, 204, 204, 204, 204, 204, 204, 204, 204, 204, 429,
      ]);
      const rejected = responses.find((response) => response.status === 429)!;
      expect(rejected.headers.getSetCookie()).toHaveLength(0);
      expect(rejected.headers.get('X-RateLimit-Limit')).toBe('10');
      expect(rejected.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(Number(rejected.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(Number(rejected.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(
        Math.floor(Date.now() / 1000),
      );
      expect(rejected.headers.get('Cache-Control')).toContain('no-store');
      expect(rejected.headers.get('Access-Control-Allow-Origin')).toBe(
        allowedOrigin,
      );
      const exposed =
        rejected.headers.get('Access-Control-Expose-Headers')?.toLowerCase() ??
        '';
      for (const header of [
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'retry-after',
        'x-ratelimit-reset',
      ]) {
        expect(exposed).toContain(header);
      }
      expect(await rejected.json()).toEqual({ message: 'Too Many Attempts.' });
      expect(await sessionCount()).toBe(10);

      const [limitedBucket] = await setup.db.query<{
        key_hash: string;
        hits: number;
      }>('SELECT key_hash, hits FROM hono_rate_limits');
      expect(Number(limitedBucket?.hits)).toBe(10);

      const otherIp = '198.51.100.17';
      const independent = await secondApp.request(
        '/api/v1/auth/csrf-cookie',
        { headers: { Origin: allowedOrigin } },
        bindings(otherIp),
      );
      await expectStatus(independent, 204);
      expect(independent.headers.get('X-RateLimit-Remaining')).toBe('9');
      expect(await sessionCount()).toBe(11);

      const buckets = await setup.db.query<{
        key_hash: string;
        hits: number;
      }>('SELECT key_hash, hits FROM hono_rate_limits ORDER BY hits DESC');
      expect(buckets.map((bucket) => Number(bucket.hits))).toEqual([10, 1]);
      for (const bucket of buckets)
        expect(bucket.key_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(buckets)).not.toContain(limitedIp);
      expect(JSON.stringify(buckets)).not.toContain(otherIp);

      await setup.db.execute(
        'UPDATE hono_rate_limits SET expires_at = ? WHERE key_hash = ?',
        [Date.now() - 1, limitedBucket!.key_hash],
      );
      const nextWindow = await secondApp.request(
        '/api/v1/auth/csrf-cookie',
        {},
        bindings(limitedIp),
      );
      await expectStatus(nextWindow, 204);
      expect(nextWindow.headers.get('X-RateLimit-Remaining')).toBe('9');
      const [resetBucket] = await setup.db.query<{ hits: number }>(
        'SELECT hits FROM hono_rate_limits WHERE key_hash = ?',
        [limitedBucket!.key_hash],
      );
      expect(Number(resetBucket?.hits)).toBe(1);
      expect(await sessionCount()).toBe(12);
    } finally {
      await secondDb.close();
    }
  });

  it('rolls back the creation allowance when session persistence fails', async () => {
    const rollbackDb: Database = {
      query: setup.db.query,
      execute: setup.db.execute,
      async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
        return setup.db.transaction((tx) =>
          fn({
            query: tx.query,
            async execute(sql, params) {
              if (sql.startsWith('INSERT INTO hono_sessions'))
                throw new Error('session-insert-sentinel');
              return tx.execute(sql, params);
            },
          }),
        );
      },
      withConnection: setup.db.withConnection,
      close: async () => undefined,
    };
    const failingApp = createApp({ db: rollbackDb, config: setup.config });
    const clientIp = '192.0.2.55';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failed = await failingApp.request(
        '/api/v1/auth/csrf-cookie',
        {},
        bindings(clientIp),
      );
      await expectStatus(failed, 500);
      expect(failed.headers.getSetCookie()).toHaveLength(0);
      expect(await sessionCount()).toBe(0);
      expect(await setup.db.query('SELECT * FROM hono_rate_limits')).toEqual(
        [],
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        'session-insert-sentinel',
      );

      const retried = await setup.app.request(
        '/api/v1/auth/csrf-cookie',
        {},
        bindings(clientIp),
      );
      await expectStatus(retried, 204);
      expect(retried.headers.get('X-RateLimit-Remaining')).toBe('9');
      expect(await sessionCount()).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps body-size and unauthenticated error precedence without issuing cookies', async () => {
    const oversized = JSON.stringify({ value: 'x'.repeat(1024 * 1024) });
    const tooLarge = await setup.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: allowedOrigin,
      },
      body: oversized,
    });
    await expectStatus(tooLarge, 413);

    const csrfError = await setup.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: allowedOrigin,
      },
      body: '{}',
    });
    await expectStatus(csrfError, 419);
    const authError = await setup.app.request('/api/v1/auth/me', {
      headers: { Origin: allowedOrigin },
    });
    await expectStatus(authError, 401);
    for (const response of [tooLarge, csrfError, authError]) {
      expect(response.headers.getSetCookie()).toHaveLength(0);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
        allowedOrigin,
      );
    }
    expect(await sessionCount()).toBe(0);
  });

  it('deletes logout state and emits expiry cookies without a live replacement', async () => {
    const client = createClient(setup.app);
    await expectStatus(await client.login(), 200);
    const sessionId = client.cookies.get(setup.config.sessionCookie)!;
    const csrfToken = client.cookies.get('XSRF-TOKEN')!;

    const logout = await client.json('/api/v1/auth/logout', 'POST');
    await expectStatus(logout, 204);
    const cookies = logout.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/Max-Age=0/i);
      expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
      expect(cookie).not.toContain(sessionId);
      expect(cookie).not.toContain(csrfToken);
    }
    expect(client.cookies.get(setup.config.sessionCookie)).toBeUndefined();
    expect(client.cookies.get('XSRF-TOKEN')).toBeUndefined();
    expect(await sessionCount()).toBe(0);

    const me = await client.request('/api/v1/auth/me');
    await expectStatus(me, 401);
    expect(me.headers.getSetCookie()).toHaveLength(0);
    const write = await client.json('/api/v1/auth/login', 'POST', {});
    await expectStatus(write, 419);
    expect(write.headers.getSetCookie()).toHaveLength(0);
    expect(await sessionCount()).toBe(0);

    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);
    expect(await sessionCount()).toBe(1);
  });

  it('cleans expired rows and retries cleanup after a surfaced failure', async () => {
    const expired = Date.now() - 1;
    await setup.db.execute(
      'INSERT INTO hono_sessions (session_id, user_id, csrf_token, expires_at) VALUES (?, NULL, ?, ?)',
      ['e'.repeat(64), 'f'.repeat(64), expired],
    );
    await setup.db.execute(
      'INSERT INTO hono_rate_limits (key_hash, hits, expires_at) VALUES (?, ?, ?)',
      ['a'.repeat(64), 10, expired],
    );
    const freshApp = createApp({ db: setup.db, config: setup.config });
    await expectStatus(await freshApp.request('/api/v1/products'), 200);
    expect(await setup.db.query('SELECT * FROM hono_sessions')).toEqual([]);
    expect(await setup.db.query('SELECT * FROM hono_rate_limits')).toEqual([]);

    let failCleanup = true;
    const retryingDb: Database = {
      query: setup.db.query,
      async execute(sql, params) {
        if (
          failCleanup &&
          sql === 'DELETE FROM hono_sessions WHERE expires_at <= ?'
        ) {
          failCleanup = false;
          throw new Error('sensitive-cleanup-sentinel');
        }
        return setup.db.execute(sql, params);
      },
      transaction: setup.db.transaction,
      withConnection: setup.db.withConnection,
      close: async () => undefined,
    };
    const retryingApp = createApp({ db: retryingDb, config: setup.config });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failed = await retryingApp.request('/api/v1/products');
      await expectStatus(failed, 500);
      expect(failed.headers.getSetCookie()).toHaveLength(0);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        'sensitive-cleanup-sentinel',
      );

      const retried = await retryingApp.request('/api/v1/products');
      await expectStatus(retried, 200);
      expect(retried.headers.getSetCookie()).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });
});
