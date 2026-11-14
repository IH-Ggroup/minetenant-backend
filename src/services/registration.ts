import type { Database, SqlExecutor } from '../db.js';
import { ValidationError } from '../domain/errors.js';
import type { SessionUserRow } from '../domain/types.js';

export interface RegistrationBase {
  readonly userId: string;
  readonly storeId: string;
  readonly passwordHash: string;
}

export interface Registration extends RegistrationBase {
  readonly username: string;
  readonly displayName: string;
}

export interface RegisteredUser extends SessionUserRow {
  username: string;
  display_name: string;
  password_hash: string;
  store_id: string;
}

export type RegistrationTransaction = (
  userId: string,
  operation: (tx: SqlExecutor) => Promise<void>,
) => Promise<void>;

function duplicateUsername(): ValidationError {
  return new ValidationError({
    username: ['このユーザー名は既に登録されています。'],
  });
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ER_DUP_ENTRY'
  );
}

function registrationUser(registration: Registration): RegisteredUser {
  return {
    user_id: registration.userId,
    username: registration.username,
    display_name: registration.displayName,
    password_hash: registration.passwordHash,
    role: 'buyer',
    store_id: registration.storeId,
  };
}

async function insertRegistration(
  tx: SqlExecutor,
  user: RegisteredUser,
): Promise<void> {
  await tx.execute(
    `INSERT INTO users
      (user_id, username, display_name, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      user.user_id,
      user.username,
      user.display_name,
      user.password_hash,
      user.role,
    ],
  );
  await tx.execute(
    `INSERT INTO stores
      (store_id, user_id, name, description, level, points, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, '', 1, 0, 'offline', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [user.store_id, user.user_id, `${user.display_name}の店舗`],
  );
}

async function usernameExists(
  db: Database,
  username: string,
): Promise<boolean> {
  const [user] = await db.query<{ user_id: string }>(
    'SELECT user_id FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  return user !== undefined;
}

/** Avoid an unnecessary bcrypt calculation; the UNIQUE constraint still closes races. */
export async function assertRegistrationIdentifierAvailable(
  db: Database,
  username: string,
): Promise<void> {
  if (await usernameExists(db, username)) throw duplicateUsername();
}

/**
 * Create the canonical user row and its initial store atomically.
 * The transaction runner also lets the auth route include session rotation in
 * the same commit without coupling this service to HTTP cookies or contexts.
 */
export async function createRegistration(
  db: Database,
  registration: Registration,
  runTransaction: RegistrationTransaction,
): Promise<RegisteredUser> {
  const user = registrationUser(registration);
  try {
    await runTransaction(registration.userId, (tx) =>
      insertRegistration(tx, user),
    );
    return user;
  } catch (error) {
    if (
      isDuplicateEntry(error) &&
      (await usernameExists(db, registration.username))
    ) {
      throw duplicateUsername();
    }
    // UUID, store, or unrelated unique-key collisions are not user-correctable.
    throw error;
  }
}
