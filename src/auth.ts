import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppConfig } from './config.js';
import type { Database, SqlExecutor } from './db.js';
import { HttpError } from './domain/errors.js';
import type { UserRow } from './domain/types.js';
import { parseBody } from './domain/validation.js';
import type { AppEnv } from './types.js';

export interface AuthSession {
  id: string;
  userId: string | null;
  csrfToken: string;
  expiresAt: number;
}

interface SessionRow {
  session_id: string;
  user_id: string | null;
  csrf_token: string;
  expires_at: number;
}

const SESSION_BOOTSTRAP_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

function sessionBootstrapKey(clientIp: string): string {
  return createHash('sha256')
    .update(`web-session-bootstrap-ip:${clientIp}`)
    .digest('hex');
}

function writeBootstrapRateHeaders(
  c: Context<AppEnv>,
  remaining: number,
): void {
  c.header('X-RateLimit-Limit', String(SESSION_BOOTSTRAP_LIMIT));
  c.header('X-RateLimit-Remaining', String(remaining));
}

function newSession(
  config: AppConfig,
  userId: string | null = null,
): AuthSession {
  return {
    id: randomBytes(32).toString('hex'),
    userId,
    csrfToken: randomBytes(32).toString('hex'),
    expiresAt: Date.now() + config.sessionLifetime * 60_000,
  };
}

async function insertSession(
  db: SqlExecutor,
  session: AuthSession,
): Promise<void> {
  await db.execute(
    'INSERT INTO hono_sessions (session_id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)',
    [session.id, session.userId, session.csrfToken, session.expiresAt],
  );
}

function writeCookies(
  c: Context<AppEnv>,
  config: AppConfig,
  session: AuthSession,
): void {
  const options = {
    path: '/',
    domain: config.sessionDomain,
    secure: config.sessionSecure,
    sameSite: config.sessionSameSite,
    maxAge: config.sessionLifetime * 60,
    expires: new Date(session.expiresAt),
  };
  setCookie(c, config.sessionCookie, session.id, {
    ...options,
    httpOnly: true,
  });
  setCookie(c, 'XSRF-TOKEN', session.csrfToken, {
    ...options,
    httpOnly: false,
  });
  c.header('Cache-Control', 'no-store, private');
}

function expireCookies(c: Context<AppEnv>, config: AppConfig): void {
  const options = {
    path: '/',
    domain: config.sessionDomain,
    secure: config.sessionSecure,
    sameSite: config.sessionSameSite,
    maxAge: 0,
    expires: new Date(0),
  };
  setCookie(c, config.sessionCookie, '', {
    ...options,
    httpOnly: true,
  });
  setCookie(c, 'XSRF-TOKEN', '', {
    ...options,
    httpOnly: false,
  });
  c.header('Cache-Control', 'no-store, private');
}

function equalToken(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const first = Buffer.from(expected);
  const second = Buffer.from(actual);
  return first.length === second.length && timingSafeEqual(first, second);
}

/** Mount only on browser routes; the Minecraft API does not use web sessions. */
export function sessionMiddleware(
  db: Database,
  config: AppConfig,
): MiddlewareHandler<AppEnv> {
  let nextCleanup = 0;
  let cleanupPromise: Promise<void> | undefined;

  async function cleanupExpired(now: number): Promise<void> {
    if (now < nextCleanup) return;
    cleanupPromise ??= (async () => {
      await db.execute('DELETE FROM hono_sessions WHERE expires_at <= ?', [
        now,
      ]);
      await db.execute('DELETE FROM hono_rate_limits WHERE expires_at <= ?', [
        now,
      ]);
      nextCleanup = Date.now() + RATE_LIMIT_WINDOW_MS;
    })().finally(() => {
      cleanupPromise = undefined;
    });
    await cleanupPromise;
  }

  return async (c, next) => {
    const now = Date.now();
    await cleanupExpired(now);
    const cookie = getCookie(c, config.sessionCookie);
    let session: AuthSession | undefined;
    if (cookie && /^[a-f0-9]{64}$/.test(cookie)) {
      const [row] = await db.query<SessionRow>(
        'SELECT session_id, user_id, csrf_token, expires_at FROM hono_sessions WHERE session_id = ? AND expires_at > ?',
        [cookie, now],
      );
      if (row) {
        const expiresAt = now + config.sessionLifetime * 60_000;
        const updated = await db.execute(
          'UPDATE hono_sessions SET expires_at = ? WHERE session_id = ? AND expires_at > ?',
          [expiresAt, row.session_id, now],
        );
        // An overlapping logout must never recreate a session it invalidated.
        if (updated.affectedRows > 0) {
          session = {
            id: row.session_id,
            userId: row.user_id,
            csrfToken: row.csrf_token,
            expiresAt,
          };
        }
      }
    }
    c.set('session', session);
    let user: UserRow | undefined;
    if (session?.userId) {
      [user] = await db.query<UserRow>(
        'SELECT users.*, stores.store_id AS store_id FROM users LEFT JOIN stores ON stores.user_id = users.user_id WHERE users.user_id = ?',
        [session.userId],
      );
    }
    c.set('user', user);

    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
        if (!session) throw new HttpError(419, 'CSRF token mismatch.');
        let token =
          c.req.header('X-CSRF-TOKEN') ?? c.req.header('X-XSRF-TOKEN');
        if (!token) {
          const body = await parseBody(c.req.raw.clone());
          token = typeof body._token === 'string' ? body._token : undefined;
        }
        if (!equalToken(session.csrfToken, token))
          throw new HttpError(419, 'CSRF token mismatch.');
      }
      await next();
    } finally {
      const responseSession = c.get('session');
      if (responseSession) writeCookies(c, config, responseSession);
    }
  };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw new HttpError(401, 'Unauthenticated.');
  await next();
};

/** Rotate both identifiers after successful registration or login. */
export async function rotateSession(
  c: Context<AppEnv>,
  db: Database,
  config: AppConfig,
  userId: string | null,
): Promise<void> {
  const previous = c.get('session');
  const replacement = newSession(config, userId);
  await db.transaction(async (tx) => {
    if (previous)
      await tx.execute('DELETE FROM hono_sessions WHERE session_id = ?', [
        previous.id,
      ]);
    await insertSession(tx, replacement);
  });
  c.set('session', replacement);
}

/** Create anonymous sessions only through the explicit CSRF bootstrap route. */
export async function bootstrapSession(
  c: Context<AppEnv>,
  db: Database,
  config: AppConfig,
): Promise<void> {
  const now = Date.now();
  const key = sessionBootstrapKey(c.get('clientIp'));
  if (c.get('session')) {
    const [row] = await db.query<{ hits: number; expires_at: number }>(
      'SELECT hits, expires_at FROM hono_rate_limits WHERE key_hash = ?',
      [key],
    );
    const hits =
      row && Number(row.expires_at) > now
        ? Math.min(SESSION_BOOTSTRAP_LIMIT, Math.max(0, Number(row.hits)))
        : 0;
    writeBootstrapRateHeaders(c, SESSION_BOOTSTRAP_LIMIT - hits);
    return;
  }

  const session = newSession(config);
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      'INSERT INTO hono_rate_limits (key_hash, hits, expires_at) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE key_hash = VALUES(key_hash)',
      [key, now + RATE_LIMIT_WINDOW_MS],
    );
    const [row] = await tx.query<{ hits: number; expires_at: number }>(
      'SELECT hits, expires_at FROM hono_rate_limits WHERE key_hash = ? FOR UPDATE',
      [key],
    );
    if (!row) throw new Error('Rate limit row disappeared.');

    const reset = Number(row.expires_at) <= now || Number(row.hits) === 0;
    const hits = reset ? 0 : Number(row.hits);
    const expiresAt = reset
      ? now + RATE_LIMIT_WINDOW_MS
      : Number(row.expires_at);
    if (hits >= SESSION_BOOTSTRAP_LIMIT) {
      return { blocked: true as const, expiresAt };
    }

    await insertSession(tx, session);
    await tx.execute(
      'UPDATE hono_rate_limits SET hits = ?, expires_at = ? WHERE key_hash = ?',
      [hits + 1, expiresAt, key],
    );
    return {
      blocked: false as const,
      expiresAt,
      remaining: SESSION_BOOTSTRAP_LIMIT - hits - 1,
    };
  });

  writeBootstrapRateHeaders(c, result.blocked ? 0 : result.remaining);
  if (result.blocked) {
    c.header(
      'Retry-After',
      String(Math.max(1, Math.ceil((result.expiresAt - now) / 1000))),
    );
    c.header('X-RateLimit-Reset', String(Math.ceil(result.expiresAt / 1000)));
    throw new HttpError(429, 'Too Many Attempts.');
  }
  c.set('session', session);
}

/** Delete the authenticated session without creating an anonymous replacement. */
export async function destroySession(
  c: Context<AppEnv>,
  db: Database,
  config: AppConfig,
): Promise<void> {
  const session = c.get('session');
  if (session) {
    await db.execute('DELETE FROM hono_sessions WHERE session_id = ?', [
      session.id,
    ]);
  }
  c.set('session', undefined);
  c.set('user', undefined);
  expireCookies(c, config);
}

/** Database-backed limits remain effective across restarts and multiple processes. */
export async function checkAuthRateLimit(
  c: Context<AppEnv>,
  db: Database,
  email: string,
): Promise<void> {
  const now = Date.now();
  const ip = c.get('clientIp');
  const limits = [
    { key: `web-auth-ip:${ip}`, max: 30 },
    { key: `web-auth-email:${email}|${ip}`, max: 5 },
  ];
  const result = await db.transaction(async (tx) => {
    const buckets: {
      key: string;
      hits: number;
      max: number;
      expiresAt: number;
    }[] = [];
    for (const limit of limits) {
      const key = createHash('sha256').update(limit.key).digest('hex');
      // The unique-key write acquires a lock even when this is the first attempt.
      await tx.execute(
        'INSERT INTO hono_rate_limits (key_hash, hits, expires_at) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE key_hash = VALUES(key_hash)',
        [key, now + 60_000],
      );
      const [row] = await tx.query<{ hits: number; expires_at: number }>(
        'SELECT hits, expires_at FROM hono_rate_limits WHERE key_hash = ? FOR UPDATE',
        [key],
      );
      if (!row) throw new Error('Rate limit row disappeared.');
      // An unused locking row must not start a window for a rejected request.
      const reset = Number(row.expires_at) <= now || Number(row.hits) === 0;
      const hits = reset ? 0 : Number(row.hits);
      const expiresAt = reset ? now + 60_000 : Number(row.expires_at);
      if (hits >= limit.max)
        return {
          blocked: true,
          max: limit.max,
          remaining: 0,
          expiresAt,
        };
      buckets.push({ key, hits, max: limit.max, expiresAt });
    }
    // A request rejected by either bucket consumes neither allowance.
    let remaining = Infinity;
    let max = 30;
    for (const bucket of buckets) {
      await tx.execute(
        'UPDATE hono_rate_limits SET hits = ?, expires_at = ? WHERE key_hash = ?',
        [bucket.hits + 1, bucket.expiresAt, bucket.key],
      );
      const available = bucket.max - bucket.hits - 1;
      if (available < remaining) {
        remaining = available;
        max = bucket.max;
      }
    }
    return { blocked: false, max, remaining, expiresAt: now + 60_000 };
  });
  c.header('X-RateLimit-Limit', String(result.max));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  if (result.blocked) {
    c.header(
      'Retry-After',
      String(Math.max(1, Math.ceil((result.expiresAt - now) / 1000))),
    );
    c.header('X-RateLimit-Reset', String(Math.ceil(result.expiresAt / 1000)));
    throw new HttpError(429, 'Too Many Attempts.');
  }
}
