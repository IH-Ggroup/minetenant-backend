import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import emailValidator from 'validator';
import { checkAuthRateLimit, requireAuth, rotateSession } from '../auth.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { ValidationError } from '../domain/errors.js';
import { serializeUser } from '../domain/serializers.js';
import type { UserRow } from '../domain/types.js';
import { parseBody, Validator, type Input } from '../domain/validation.js';
import type { AppEnv } from '../types.js';

function credentials(data: Input, register: boolean) {
  if (typeof data.email === 'string')
    data.email = data.email.trim().toLowerCase();
  const validator = new Validator(data);
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

function duplicateEmail(): ValidationError {
  return new ValidationError({
    email: ['このメールアドレスは既に登録されています。'],
  });
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

  routes.get('/csrf-cookie', (c) => c.body(null, 204));

  routes.post('/register', async (c) => {
    const body = await parseBody(c.req.raw);
    await checkAuthRateLimit(
      c,
      db,
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '',
    );
    const { name, email, password } = credentials(body, true);
    const [existing] = await db.query<{ id: string }>(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email],
    );
    if (existing) throw duplicateEmail();
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const id = randomUUID();
    const storeId = randomUUID();
    const user: UserRow = {
      id,
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
          `INSERT INTO users (id, name, email, password, role, role_label, avatar_initial, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            id,
            name,
            email,
            passwordHash,
            user.role,
            user.role_label,
            user.avatar_initial,
          ],
        );
        await tx.execute(
          `INSERT INTO stores (id, owner_id, name, description, level, points, sync_status, created_at, updated_at)
           VALUES (?, ?, ?, '', 1, 0, 'offline', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [storeId, id, `${name}の店舗`],
        );
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ER_DUP_ENTRY'
      ) {
        const [competing] = await db.query<{ id: string }>(
          'SELECT id FROM users WHERE email = ? LIMIT 1',
          [email],
        );
        if (competing) throw duplicateEmail();
      }
      throw error;
    }
    await rotateSession(c, db, config, id);
    c.set('user', user);
    return c.json({ data: serializeUser(user) }, 201);
  });

  routes.post('/login', async (c) => {
    const body = await parseBody(c.req.raw);
    await checkAuthRateLimit(
      c,
      db,
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '',
    );
    const { email, password } = credentials(body, false);
    const [user] = await db.query<UserRow>(
      'SELECT users.*, stores.id AS store_id FROM users LEFT JOIN stores ON stores.owner_id = users.id WHERE users.email = ? LIMIT 1',
      [email],
    );
    const storedHash = user?.password ?? (await dummyHash);
    // Laravel emits $2y$ hashes; the algorithm is the same as bcrypt's $2b$ variant.
    const valid = await bcrypt.compare(
      password,
      storedHash.replace(/^\$2y\$/, '$2b$'),
    );
    if (!user || !valid) {
      throw new ValidationError({
        email: ['メールアドレスまたはパスワードが正しくありません。'],
      });
    }
    if (bcrypt.getRounds(storedHash) !== config.bcryptRounds) {
      await db.execute(
        'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND password = ?',
        [await bcrypt.hash(password, config.bcryptRounds), user.id, storedHash],
      );
    }
    await rotateSession(c, db, config, user.id);
    c.set('user', user);
    return c.json({ data: serializeUser(user) });
  });

  routes.get('/me', requireAuth, (c) =>
    c.json({ data: serializeUser(c.get('user')!) }),
  );
  routes.post('/logout', requireAuth, async (c) => {
    await rotateSession(c, db, config, null);
    c.set('user', undefined);
    return c.body(null, 204);
  });
  return routes;
}
