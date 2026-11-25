import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppConfig } from './config.js';
import type { AppEnv } from './types.js';

const AUTHENTICATION_FAILED = {
  message: 'Fabric server authentication failed.',
  code: 'FABRIC_AUTHENTICATION_FAILED',
} as const;

const AUTHENTICATION_UNAVAILABLE = {
  message: 'Fabric server authentication is unavailable.',
  code: 'FABRIC_AUTHENTICATION_UNAVAILABLE',
} as const;

export function isValidFabricServerToken(token: string): boolean {
  return (
    token.length >= 64 && token.length <= 256 && !/[^\x21-\x7e]/.test(token)
  );
}

export function assertFabricServerTokenConfigured(config: AppConfig): void {
  if (!isValidFabricServerToken(config.fabricServerToken)) {
    throw new Error(
      'MINETENANT_FABRIC_SERVER_TOKEN must be 64 to 256 printable ASCII characters without whitespace.',
    );
  }
}

function bearerToken(authorization: string | undefined): string {
  return /^Bearer ([^\s]+)$/i.exec(authorization ?? '')?.[1] ?? '';
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function fabricServerAuth(config: AppConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isValidFabricServerToken(config.fabricServerToken)) {
      return c.json(AUTHENTICATION_UNAVAILABLE, 503);
    }

    const provided = bearerToken(c.req.header('Authorization'));
    if (!timingSafeEqual(digest(provided), digest(config.fabricServerToken))) {
      c.header('WWW-Authenticate', 'Bearer realm="minetenant-fabric"');
      return c.json(AUTHENTICATION_FAILED, 401);
    }

    await next();
  };
}
