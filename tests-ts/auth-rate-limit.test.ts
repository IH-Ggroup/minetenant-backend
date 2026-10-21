import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { checkAuthRateLimit } from '../src/auth.js';
import type { Database } from '../src/db.js';
import { HttpError } from '../src/domain/errors.js';
import type { AppEnv } from '../src/types.js';

describe('authentication rate-limit lookup order', () => {
  it('skips account resolution and transactions when the IP is already blocked', async () => {
    const resolveAccountKey = vi.fn(() => 'username:must-not-be-resolved');
    const transaction = vi.fn(() => {
      throw new Error('The blocked request must not start a transaction.');
    });
    const db = {
      query: vi.fn(async () => [{ hits: 30, expires_at: Date.now() + 60_000 }]),
      transaction,
    } as unknown as Database;
    const app = new Hono<AppEnv>();
    app.onError((error, c) =>
      error instanceof HttpError
        ? c.json({ message: error.message }, 429)
        : c.json({ message: error.message }, 500),
    );
    app.use('*', async (c, next) => {
      c.set('clientIp', '203.0.113.10');
      await next();
    });
    app.get('/', async (c) => {
      await checkAuthRateLimit(c, db, resolveAccountKey);
      return c.json({ ok: true });
    });

    const response = await app.request('/');

    expect(response.status).toBe(429);
    expect(resolveAccountKey).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(response.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
  });
});
