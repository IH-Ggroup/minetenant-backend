import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { methodNotAllowed } from 'hono/method-not-allowed';
import { matchedRoutes } from 'hono/route';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { sessionMiddleware, requireAuth } from './auth.js';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { HttpError } from './domain/errors.js';
import { createAuthRoutes } from './routes/auth.js';
import { createCatalogRoutes } from './routes/catalog.js';
import { createPurchaseRoutes } from './routes/purchases.js';
import type { AppEnv } from './types.js';

export function createApp({
  db,
  config,
}: {
  db: Database;
  config: AppConfig;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        {
          message: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.errors ? { errors: error.errors } : {}),
        },
        error.status as ContentfulStatusCode,
      );
    }
    if (error instanceof HTTPException)
      return c.json({ message: error.message }, error.status);
    // Never expose SQL values, password hashes, tokens or stack traces in API responses/logs.
    console.error(
      'API_REQUEST_FAILED',
      error instanceof Error ? error.name : 'UnknownError',
    );
    return c.json({ message: 'Server Error' }, 500);
  });
  app.notFound((c) => c.json({ message: 'Not found.' }, 404));

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store, private');
    const remoteIp = c.env?.incoming?.socket.remoteAddress ?? '127.0.0.1';
    c.set('clientIp', remoteIp);
    if (config.publicTunnel) {
      if (config.debug || config.originToken.length < 32)
        throw new HttpError(503, 'Service unavailable.');
      const provided = Buffer.from(
        c.req.header('X-MineTenant-Origin-Token') ?? '',
      );
      const expected = Buffer.from(config.originToken);
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      ) {
        throw new HttpError(403, 'Forbidden.');
      }
      const forwardedIp = c.req.header('X-MineTenant-Client-IP');
      if (
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp) &&
        forwardedIp &&
        isIP(forwardedIp)
      ) {
        c.set('clientIp', forwardedIp);
      }
      const path = c.req.path;
      if (
        !/^\/api\/v1\/(?:auth\/(?:csrf-cookie|register|login|me|logout)|products(?:\/.*)?|stores\/.+|purchases|transactions(?:\/.*)?)$/.test(
          path,
        )
      ) {
        throw new HttpError(404, 'Not found.');
      }
    }
    await next();
  });

  const corsMiddleware = cors({
    origin: (origin) => (config.corsOrigins.includes(origin) ? origin : ''),
    credentials: true,
    allowMethods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
    maxAge: 3600,
  });
  app.use(
    '*',
    methodNotAllowed({
      app,
      onMethodNotAllowed: (c, methods) =>
        c.json({ message: 'Method Not Allowed' }, 405, {
          Allow: methods.join(', '),
        }),
    }),
  );
  app.use('/api/*', corsMiddleware);
  app.use('/up', corsMiddleware);
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ message: 'Payload Too Large' }, 413),
    }),
  );

  app.get('/', (c) =>
    c.json({
      service: 'MineTenant Backend',
      status: 'ok',
      hello: `${config.appUrl}/api/hello`,
      health: `${config.appUrl}/up`,
    }),
  );
  app.get('/up', (c) => c.json({ status: 'ok' }));
  app.get('/api/hello', (c) => c.text('MineTenant API is running.'));

  const webSession = sessionMiddleware(db, config);
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path.startsWith('/api/v1/minecraft/')) return next();
    if (!matchedRoutes(c).some((route) => route.method !== 'ALL'))
      return next();
    return webSession(c, next);
  });
  app.route('/api/v1/auth', createAuthRoutes(db, config));
  app.route('/api/v1', createCatalogRoutes(db, config, requireAuth));
  app.route('/api/v1', createPurchaseRoutes(db, config, requireAuth));
  return app;
}
