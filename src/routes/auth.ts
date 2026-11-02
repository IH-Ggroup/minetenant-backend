import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import emailValidator from 'validator';
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
import { SYNTHETIC_EMAIL_PATTERN } from '../db/auth-backfill.js';
import {
  isCanonicalUsername,
  normalizeUsername,
  parseLoginCredentials,
  parseRegisterCredentials,
} from '../domain/auth-credentials.js';
import { HttpError, ValidationError } from '../domain/errors.js';
import { serializeSessionUser, serializeUser } from '../domain/serializers.js';
import type { AuthenticatedUserRow } from '../domain/types.js';
import {
  assertRegistrationIdentifierAvailable,
  createRegistration,
  duplicateEmail,
  type Registration,
  type RegistrationBase,
} from '../services/registration.js';
import {
  normalizeInput,
  parseBody,
  parseJsonBody,
  Validator,
  type Input,
} from '../domain/validation.js';
import type { AppEnv } from '../types.js';

const supportedBcryptHash = /^\$2[by]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/;
const invalidCredentialsMessage =
  'ユーザー名またはパスワードが正しくありません。';

interface PasswordHashColumn {
  password_hash: string | null;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
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

async function emailAccountKey(
  db: Database,
  rawEmail: string,
  resolveAlias: boolean,
): Promise<string> {
  const email = normalizeEmail(rawEmail);
  if (!resolveAlias) return `email:${email}`;
  if (email === '' || email.length > 255) return `email:${email}`;
  const [user] = await db.query<{ username: string | null }>(
    'SELECT username FROM users WHERE email = ? LIMIT 1',
    [email],
  );
  return user?.username && isCanonicalUsername(user.username)
    ? `username:${user.username}`
    : `email:${email}`;
}

async function registrationAccountKey(
  db: Database,
  body: Input,
): Promise<string> {
  if (typeof body.username === 'string')
    return `username:${normalizeUsername(body.username)}`;
  if (typeof body.email === 'string')
    return emailAccountKey(db, body.email, true);
  return 'empty';
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

const usernameRegisterFields = [
  'username',
  'displayName',
  'passwordConfirmation',
] as const;
const legacyRegisterFields = [
  'name',
  'email',
  'password_confirmation',
] as const;

function presentFields(
  body: Input,
  fields: readonly string[],
): readonly string[] {
  return fields.filter((field) => Object.hasOwn(body, field));
}

function registerRequestKind(body: Input): 'username' | 'legacy' {
  const usernameFields = presentFields(body, usernameRegisterFields);
  const legacyFields = presentFields(body, legacyRegisterFields);
  if (usernameFields.length > 0 && legacyFields.length > 0) {
    const message = '新しい登録項目と従来の登録項目は同時に指定できません。';
    throw new ValidationError(
      Object.fromEntries(
        [...usernameFields, ...legacyFields].map((field) => [field, [message]]),
      ),
    );
  }
  return legacyFields.length > 0 ? 'legacy' : 'username';
}

function rejectReservedLegacyEmail(email: string): void {
  if (!SYNTHETIC_EMAIL_PATTERN.test(email)) return;
  throw new ValidationError({
    email: ['このメールアドレスは使用できません。'],
  });
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

function validateEmail(validator: Validator): string | undefined {
  const email = validator.string('email', {
    required: true,
    max: 255,
    messages: { required: 'メールアドレスを入力してください。' },
  });
  if (
    email &&
    !emailValidator.isEmail(email, {
      require_tld: false,
      allow_ip_domain: true,
    })
  ) {
    validator.add('email', '有効なメールアドレスを入力してください。');
  }
  return email;
}

function credentials(data: Input, register: boolean) {
  if (typeof data.email === 'string') data.email = normalizeEmail(data.email);
  const validator = new Validator(data);
  const email = validateEmail(validator);
  const password = validator.string('password', {
    required: true,
    min: register ? 8 : undefined,
    messages: {
      required: 'パスワードを入力してください。',
      min: 'パスワードは8文字以上で入力してください。',
    },
  });
  if (password !== undefined) {
    if (Buffer.byteLength(password, 'utf8') > 72)
      validator.add('password', 'パスワードは72バイト以内で入力してください。');
    if (password.includes('\0'))
      validator.add('password', 'The password field format is invalid.');
  }
  let name: string | undefined;
  if (register) {
    name = validator.string('name', {
      required: true,
      max: 120,
      messages: { required: '名前を入力してください。' },
    });
    if (validator.has('password_confirmation')) {
      const confirmation = validator.string('password_confirmation', {
        required: true,
      });
      if (confirmation !== undefined && confirmation !== password) {
        validator.add(
          'password_confirmation',
          '確認用パスワードが一致しません。',
        );
      }
    }
  }
  validator.throwIfInvalid();
  return { email: email!, password: password!, name: name! };
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
    if (config.usernameAuthEnabled) {
      // Keep raw canonical values intact while applying legacy normalization
      // only when the temporary legacy request contract is selected.
      const body = await parseJsonBody(c.req.raw);
      await checkAuthRateLimit(c, db, () => registrationAccountKey(db, body));
      const kind = registerRequestKind(body);

      let registration: Registration;
      if (kind === 'username') {
        const current = parseRegisterCredentials(body);
        await assertRegistrationIdentifierAvailable(db, {
          kind,
          username: current.username,
        });
        registration = {
          kind,
          ...(await createRegistrationBase(
            current.password,
            config.bcryptRounds,
          )),
          username: current.username,
          displayName: current.displayName,
        };
      } else {
        const legacy = credentials(normalizeInput(body), true);
        rejectReservedLegacyEmail(legacy.email);
        await assertRegistrationIdentifierAvailable(db, {
          kind,
          email: legacy.email,
        });
        registration = {
          kind,
          ...(await createRegistrationBase(
            legacy.password,
            config.bcryptRounds,
          )),
          name: legacy.name,
          email: legacy.email,
        };
      }
      const user = await createRegistration(
        db,
        registration,
        (registeredUserId, operation) =>
          rotateSessionWith(c, db, config, registeredUserId, operation),
      );
      const dto = serializeSessionUser(user);
      return c.json({ data: { ...dto, name: dto.displayName } }, 201);
    }

    const body = await parseBody(c.req.raw);
    await checkAuthRateLimit(c, db, () =>
      typeof body.email === 'string'
        ? emailAccountKey(db, body.email, false)
        : 'email:',
    );
    const { name, email, password } = credentials(body, true);
    const [existing] = await db.query<{ user_id: string }>(
      'SELECT user_id FROM users WHERE email = ? LIMIT 1',
      [email],
    );
    if (existing) throw duplicateEmail();
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const userId = randomUUID();
    const storeId = randomUUID();
    const user: AuthenticatedUserRow = {
      user_id: userId,
      username: null,
      display_name: null,
      password_hash: null,
      name,
      email,
      password: passwordHash,
      role: 'buyer',
      role_label: '購入者',
      avatar_initial: Array.from(name)[0]!,
      store_id: storeId,
    };
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO users (user_id, name, email, password, role, role_label, avatar_initial, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            userId,
            name,
            email,
            passwordHash,
            user.role,
            user.role_label,
            user.avatar_initial,
          ],
        );
        await tx.execute(
          `INSERT INTO stores (store_id, user_id, name, description, level, points, sync_status, created_at, updated_at)
           VALUES (?, ?, ?, '', 1, 0, 'offline', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [storeId, userId, `${name}の店舗`],
        );
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ER_DUP_ENTRY'
      ) {
        const [competing] = await db.query<{ user_id: string }>(
          'SELECT user_id FROM users WHERE email = ? LIMIT 1',
          [email],
        );
        if (competing) throw duplicateEmail();
      }
      throw error;
    }
    await rotateSession(c, db, config, userId);
    c.set('user', user);
    return c.json({ data: serializeUser(user) }, 201);
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
    if (!config.usernameAuthEnabled)
      return c.json({ data: serializeUser(user) });
    const dto = serializeSessionUser(user);
    return c.json({ data: { ...dto, name: dto.displayName } });
  });
  routes.post('/logout', requireAuth, async (c) => {
    await destroySession(c, db, config);
    return c.body(null, 204);
  });
  return routes;
}
