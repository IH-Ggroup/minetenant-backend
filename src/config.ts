export interface AppConfig {
  appEnv: string;
  appUrl: string;
  debug: boolean;
  host: string;
  port: number;
  dbHost: string;
  dbPort: number;
  dbDatabase: string;
  dbUsername: string;
  dbPassword: string;
  sessionCookie: string;
  sessionLifetime: number;
  sessionSecure: boolean;
  sessionSameSite: 'Lax' | 'Strict' | 'None';
  sessionDomain?: string;
  bcryptRounds: number;
  corsOrigins: string[];
  publicTunnel: boolean;
  originToken: string;
  salePoints: number;
}

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(
      `Configuration requires an integer between ${min} and ${max}.`,
    );
  }
  return number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appEnv = env.APP_ENV ?? 'local';
  const appUrl = env.APP_URL ?? 'http://localhost:8787';
  const sameSite = (env.SESSION_SAME_SITE ?? 'lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite))
    throw new Error('Invalid SESSION_SAME_SITE.');
  const sessionSecure =
    env.SESSION_SECURE_COOKIE === undefined
      ? new URL(appUrl).protocol === 'https:'
      : env.SESSION_SECURE_COOKIE === 'true';
  if (sameSite === 'none' && !sessionSecure)
    throw new Error('SameSite=None requires secure cookies.');
  if (env.DB_CONNECTION && env.DB_CONNECTION !== 'mysql')
    throw new Error('DB_CONNECTION must be mysql.');
  if (env.DB_URL)
    throw new Error(
      'Use DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME / DB_PASSWORD instead of DB_URL.',
    );
  return {
    appEnv,
    appUrl,
    debug: env.APP_DEBUG === 'true',
    host: env.HOST ?? '127.0.0.1',
    port: integer(env.PORT, 8787, 1, 65535),
    dbHost: env.DB_HOST ?? '127.0.0.1',
    dbPort: integer(env.DB_PORT, 3306, 1, 65535),
    dbDatabase: env.DB_DATABASE ?? 'minetenant',
    dbUsername: env.DB_USERNAME ?? 'minetenant',
    dbPassword: env.DB_PASSWORD ?? '',
    sessionCookie: env.HONO_SESSION_COOKIE ?? 'minetenant_hono_session',
    sessionLifetime: integer(env.SESSION_LIFETIME, 120, 1, 525600),
    sessionSecure,
    sessionSameSite:
      sameSite === 'none' ? 'None' : sameSite === 'strict' ? 'Strict' : 'Lax',
    sessionDomain:
      env.SESSION_DOMAIN && env.SESSION_DOMAIN !== 'null'
        ? env.SESSION_DOMAIN
        : undefined,
    bcryptRounds: integer(env.BCRYPT_ROUNDS, 12, 4, 16),
    corsOrigins: (
      env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173'
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    publicTunnel: env.MINETENANT_PUBLIC_TUNNEL === 'true',
    originToken: env.MINETENANT_ORIGIN_TOKEN ?? '',
    salePoints: Math.max(
      0,
      integer(env.STORE_SALE_POINTS, 100, -4294967295, 4294967295),
    ),
  };
}
