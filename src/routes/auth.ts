import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import {
  bootstrapSession,
  checkAuthRateLimit,
  destroySession,
  findUsernameLoginUser,
  requireAuth,
  rotateSession,
  rotateSessionWith,
} from '../auth.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import {
  normalizeUsername,
  parseLoginCredentials,
  parseRegisterCredentials,
} from '../domain/auth-credentials.js';
import { HttpError, ValidationError } from '../domain/errors.js';
import { serializeSessionUser } from '../domain/serializers.js';
import {
  assertRegistrationIdentifierAvailable,
  createRegistration,
  type RegistrationBase,
} from '../services/registration.js';
import { parseJsonBody, type Input } from '../domain/validation.js';
import type { AppEnv } from '../types.js';

const supportedBcryptHash = /^\$2[by]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/;
const invalidCredentialsMessage =
  'ユーザー名またはパスワードが正しくありません。';
const removedRegisterFields = [
  'name',
  'email',
  'password_confirmation',
] as const;

interface PasswordHashColumn {
  password_hash: string | null;
}

function comparableBcryptHash(value: unknown): string | undefined {
  if (typeof value !== 'string' || !supportedBcryptHash.test(value))
    return undefined;
  return value.replace(/^\$2y\$/, '$2b$');
}

async function passwordMatches(
  password: string,
  storedHash: unknown,
  dummyHash: string,
): Promise<boolean> {
  const candidate = comparableBcryptHash(storedHash) ?? dummyHash;
  try {
    const matches = await bcrypt.compare(password, candidate);
    return comparableBcryptHash(storedHash) !== undefined && matches;
  } catch {
    return false;
  }
}

async function rehashPasswordIfNeeded({
  db,
  config,
  userId,
  password,
  storedHash,
  dummyHash,
}: {
  db: Database;
  config: AppConfig;
  userId: string;
  password: string;
  storedHash: string;
  dummyHash: string;
}): Promise<boolean> {
  const comparable = comparableBcryptHash(storedHash);
  if (!comparable) return false;
  const rounds = Number(comparable.slice(4, 6));
  if (rounds >= config.bcryptRounds) return true;

  const replacement = await bcrypt.hash(password, config.bcryptRounds);
  const result = await db.execute(
    `UPDATE users
        SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND BINARY password_hash = BINARY ?`,
    [replacement, userId, storedHash],
  );
  if (result.affectedRows > 0) return true;

  // A concurrent password update won the compare-and-swap. Authenticate the
  // value that is current now, but never overwrite it with our stale result.
  const [latest] = await db.query<PasswordHashColumn>(
    'SELECT password_hash FROM users WHERE user_id = ? LIMIT 1',
    [userId],
  );
  return passwordMatches(password, latest?.password_hash, dummyHash);
}

function registrationAccountKey(body: Input): string {
  return typeof body.username === 'string'
    ? `username:${normalizeUsername(body.username)}`
    : 'empty';
}

function loginAccountKey(body: Input): string {
  return typeof body.username === 'string'
    ? `username:${normalizeUsername(body.username)}`
    : 'empty';
}

function rejectRemovedLoginFields(body: Input): void {
  if (!Object.hasOwn(body, 'email')) return;
  throw new ValidationError({
    email: ['メールアドレスでのログインは利用できません。'],
  });
}

function rejectRemovedRegisterFields(body: Input): void {
  const fields = removedRegisterFields.filter((field) =>
    Object.hasOwn(body, field),
  );
  if (fields.length === 0) return;
  const message = 'この登録項目は利用できません。';
  throw new ValidationError(
    Object.fromEntries(fields.map((field) => [field, [message]])),
  );
}

async function createRegistrationBase(
  password: string,
  bcryptRounds: number,
): Promise<RegistrationBase> {
  const passwordHash = await bcrypt.hash(password, bcryptRounds);
  return {
    userId: randomUUID(),
    storeId: randomUUID(),
    passwordHash,
  };
}

export function createAuthRoutes(
  db: Database,
  config: AppConfig,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  // Compare against a real hash for unknown users as well as known users.
  const dummyHash = bcrypt.hash(
    randomBytes(32).toString('hex'),
    config.bcryptRounds,
  );

  routes.get('/csrf-cookie', async (c) => {
    // Hono also dispatches HEAD to GET handlers. Only an explicit GET may
    // create an anonymous session.
    if (c.req.method === 'GET') await bootstrapSession(c, db, config);
    return c.body(null, 204);
  });

  routes.post('/register', async (c) => {
    const body = await parseJsonBody(c.req.raw);
    await checkAuthRateLimit(c, db, () => registrationAccountKey(body));
    rejectRemovedRegisterFields(body);
    const credentials = parseRegisterCredentials(body);
    await assertRegistrationIdentifierAvailable(db, credentials.username);
    const registration = {
      ...(await createRegistrationBase(
        credentials.password,
        config.bcryptRounds,
      )),
      username: credentials.username,
      displayName: credentials.displayName,
    };
    const user = await createRegistration(
      db,
      registration,
      (registeredUserId, operation) =>
        rotateSessionWith(c, db, config, registeredUserId, operation),
    );
    return c.json({ data: serializeSessionUser(user) }, 201);
  });

  routes.post('/login', async (c) => {
    const body = await parseJsonBody(c.req.raw);
    await checkAuthRateLimit(c, db, () => loginAccountKey(body));
    rejectRemovedLoginFields(body);
    const { username, password } = parseLoginCredentials(body);

    const user = await findUsernameLoginUser(db, username);
    const resolvedDummyHash = await dummyHash;
    const storedHash = user?.password_hash;
    const valid = await passwordMatches(
      password,
      storedHash,
      resolvedDummyHash,
    );
    if (!user || !valid) throw new HttpError(401, invalidCredentialsMessage);

    // Validate the public response before mutating credentials or rotating the
    // session. Cutover preflight should make this a no-op in practice.
    const dto = serializeSessionUser(user);
    if (
      typeof storedHash !== 'string' ||
      !(await rehashPasswordIfNeeded({
        db,
        config,
        userId: user.user_id,
        password,
        storedHash,
        dummyHash: resolvedDummyHash,
      }))
    ) {
      throw new HttpError(401, invalidCredentialsMessage);
    }
    await rotateSession(c, db, config, user.user_id);
    return c.json({ data: dto });
  });

  routes.get('/me', requireAuth, (c) => {
    const user = c.get('user')!;
    return c.json({ data: serializeSessionUser(user) });
  });
  routes.post('/logout', requireAuth, async (c) => {
    await destroySession(c, db, config);
    return c.body(null, 204);
  });
  return routes;
}
