import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { createApp } from '../src/app.js';
import { readConfig, type AppConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type { AppEnv } from '../src/types.js';
import { migrate } from '../scripts/migrate.js';
import { seedDemo } from '../scripts/seed.js';

const TEST_DATABASE = 'minetenant_hono_migration_test';

/** Real MySQL, always separate from both development and the old Laravel test database. */
export async function createTestApp(overrides: Partial<AppConfig> = {}) {
  const config = {
    ...readConfig({
      ...process.env,
      NODE_ENV: 'test',
      APP_ENV: 'testing',
      APP_URL: 'http://localhost:8787',
      APP_DEBUG: 'false',
      DB_CONNECTION: 'mysql',
      DB_URL: undefined,
      DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
      DB_PORT: process.env.TEST_DB_PORT ?? '3306',
      DB_DATABASE: TEST_DATABASE,
      DB_USERNAME: process.env.TEST_DB_USERNAME ?? 'minetenant',
      DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? 'minetenant',
      BCRYPT_ROUNDS: '4',
      SESSION_SECURE_COOKIE: 'false',
      SESSION_SAME_SITE: 'lax',
      SESSION_DOMAIN: 'null',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
      MINETENANT_PUBLIC_TUNNEL: 'false',
    }),
    ...overrides,
  };
  assert.equal(
    config.dbDatabase,
    TEST_DATABASE,
    'Test database overrides must remain isolated.',
  );
  const db = createDatabase(config);
  const database = await db.query<{ name: string }>(
    'SELECT DATABASE() AS name',
  );
  assert.equal(
    database[0]?.name,
    TEST_DATABASE,
    'Tests may only reset their dedicated MySQL database.',
  );
  await migrate(db);
  const app = createApp({ db, config });

  return {
    app,
    db,
    config,
    async reset() {
      await db.transaction(async (tx) => {
        for (const table of [
          'hono_rate_limits',
          'hono_sessions',
          'purchase_transactions',
          'products',
          'stores',
          'users',
        ]) {
          await tx.execute(`DELETE FROM ${table}`);
        }
      });
      await seedDemo(db, 4);
    },
    close: () => db.close(),
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export function createClient(app: Pick<Hono<AppEnv>, 'request'>) {
  const cookies = new Map<string, string>();

  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has('Cookie') && cookies.size > 0) {
      headers.set(
        'Cookie',
        [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      );
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
      !headers.has('X-XSRF-TOKEN')
    ) {
      const token = cookies.get('XSRF-TOKEN');
      if (token) headers.set('X-XSRF-TOKEN', decodeURIComponent(token));
    }
    headers.set('Accept', 'application/json');
    const response = await app.request(`http://localhost${path}`, {
      ...init,
      headers,
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]!;
      const equals = pair.indexOf('=');
      const key = pair.slice(0, equals);
      const value = pair.slice(equals + 1);
      if (/;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(key);
      else cookies.set(key, value);
    }
    return response;
  }

  function json(path: string, method: string, payload?: unknown) {
    return request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  }

  return {
    cookies,
    request,
    json,
    async login(email = 'demo@minetenant.jp', password = 'password') {
      const csrf = await request('/api/v1/auth/csrf-cookie');
      assert.equal(csrf.status, 204);
      return json('/api/v1/auth/login', 'POST', { email, password });
    },
  };
}

export type TestClient = ReturnType<typeof createClient>;

export async function expectStatus(response: Response, status: number) {
  assert.equal(response.status, status, await response.clone().text());
  return response;
}
