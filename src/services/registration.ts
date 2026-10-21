import type { Database, SqlExecutor } from '../db.js';
import {
  syntheticEmailCandidate,
  usernameCandidate,
} from '../db/auth-backfill.js';
import { ValidationError } from '../domain/errors.js';
import type { SessionUserRow } from '../domain/types.js';

const MAX_GENERATED_IDENTIFIER_ATTEMPTS = 100;

interface RegistrationBase {
  readonly userId: string;
  readonly storeId: string;
  readonly passwordHash: string;
}

export interface UsernameRegistration extends RegistrationBase {
  readonly kind: 'username';
  readonly username: string;
  readonly displayName: string;
}

export interface LegacyRegistration extends RegistrationBase {
  readonly kind: 'legacy';
  readonly name: string;
  readonly email: string;
}

export type Registration = UsernameRegistration | LegacyRegistration;

export type RegistrationIdentifier =
  | Pick<UsernameRegistration, 'kind' | 'username'>
  | Pick<LegacyRegistration, 'kind' | 'email'>;

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

interface RegistrationRecord {
  readonly user: RegisteredUser;
  readonly name: string;
  readonly email: string;
  readonly legacyPasswordHash: string;
  readonly roleLabel: '購入者';
  readonly avatarInitial: string;
}

export class RegistrationIdentifierAllocationError extends Error {
  readonly code = 'MINETENANT_REGISTRATION_IDENTIFIER_EXHAUSTED';

  constructor() {
    super('A compatible registration identifier could not be allocated.');
    this.name = 'RegistrationIdentifierAllocationError';
  }
}

function duplicateUsername(): ValidationError {
  return new ValidationError({
    username: ['このユーザー名は既に登録されています。'],
  });
}

export function duplicateEmail(): ValidationError {
  return new ValidationError({
    email: ['このメールアドレスは既に登録されています。'],
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

function firstCodePoint(value: string): string {
  return Array.from(value)[0]!;
}

function registrationRecord(
  registration: Registration,
  attempt: number,
): RegistrationRecord {
  const username =
    registration.kind === 'username'
      ? registration.username
      : usernameCandidate(registration.userId, attempt);
  const displayName =
    registration.kind === 'username'
      ? registration.displayName
      : registration.name;
  const email =
    registration.kind === 'username'
      ? syntheticEmailCandidate(registration.userId, attempt)
      : registration.email;

  return {
    user: {
      user_id: registration.userId,
      username,
      display_name: displayName,
      password_hash: registration.passwordHash,
      role: 'buyer',
      store_id: registration.storeId,
    },
    name: displayName,
    email,
    legacyPasswordHash: registration.passwordHash,
    roleLabel: '購入者',
    avatarInitial: firstCodePoint(displayName),
  };
}

async function insertRegistration(
  tx: SqlExecutor,
  record: RegistrationRecord,
): Promise<void> {
  await tx.execute(
    `INSERT INTO users
      (user_id, username, display_name, password_hash,
       name, email, password, role, role_label, avatar_initial,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      record.user.user_id,
      record.user.username,
      record.user.display_name,
      record.user.password_hash,
      record.name,
      record.email,
      record.legacyPasswordHash,
      record.user.role,
      record.roleLabel,
      record.avatarInitial,
    ],
  );
  await tx.execute(
    `INSERT INTO stores
      (store_id, user_id, name, description, level, points, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, '', 1, 0, 'offline', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      record.user.store_id,
      record.user.user_id,
      `${record.user.display_name}の店舗`,
    ],
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

async function emailExists(db: Database, email: string): Promise<boolean> {
  const [user] = await db.query<{ user_id: string }>(
    'SELECT user_id FROM users WHERE email = ? LIMIT 1',
    [email],
  );
  return user !== undefined;
}

/** Avoid an unnecessary bcrypt calculation; the UNIQUE constraint still closes races. */
export async function assertRegistrationIdentifierAvailable(
  db: Database,
  identifier: RegistrationIdentifier,
): Promise<void> {
  if (identifier.kind === 'username') {
    if (await usernameExists(db, identifier.username))
      throw duplicateUsername();
    return;
  }
  if (await emailExists(db, identifier.email)) throw duplicateEmail();
}

/**
 * Create the compatibility user row and its initial store atomically.
 * The transaction runner also lets the auth route include session rotation in
 * the same commit without coupling this service to HTTP cookies or contexts.
 */
export async function createRegistration(
  db: Database,
  registration: Registration,
  runTransaction: RegistrationTransaction,
): Promise<RegisteredUser> {
  for (
    let attempt = 0;
    attempt < MAX_GENERATED_IDENTIFIER_ATTEMPTS;
    attempt += 1
  ) {
    const record = registrationRecord(registration, attempt);
    try {
      await runTransaction(registration.userId, (tx) =>
        insertRegistration(tx, record),
      );
      return record.user;
    } catch (error) {
      if (!isDuplicateEntry(error)) throw error;

      if (registration.kind === 'username') {
        // The public identifier wins over an internal compatibility collision.
        // This also turns a concurrent registration race into the documented 422.
        if (await usernameExists(db, registration.username))
          throw duplicateUsername();
        if (await emailExists(db, record.email)) continue;
      } else {
        // Preserve the legacy field contract while that request remains accepted.
        if (await emailExists(db, registration.email)) throw duplicateEmail();
        if (await usernameExists(db, record.user.username)) continue;
      }

      // A UUID, store, or unrelated unique-key collision is not a user-correctable
      // identifier conflict. Keep the original database failure internal.
      throw error;
    }
  }

  throw new RegistrationIdentifierAllocationError();
}
