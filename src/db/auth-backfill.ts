import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Database, MigrationExecutor, SqlExecutor } from '../db.js';
import { assertAuthBackfillCommandReady } from './auth-schema.js';

export type AuthBackfillMode = 'check' | 'apply';

export const AUTH_BACKFILL_VIOLATION_CODES = [
  'LEGACY_COMPATIBILITY_INCOMPLETE',
  'USERNAME_INVALID',
  'USERNAME_DUPLICATE',
  'RESERVED_USERNAME_OWNER_INVALID',
  'FIXED_USERNAME_MISMATCH',
  'USERNAME_GENERATION_EXHAUSTED',
  'DISPLAY_NAME_INVALID',
  'PASSWORD_HASH_INVALID',
  'PASSWORD_HASH_MISMATCH',
  'ROLE_INVALID',
  'SYNTHETIC_EMAIL_INVALID',
  'SYNTHETIC_COMPATIBILITY_MISMATCH',
  'NEW_COLUMNS_INCOMPLETE',
  'NEW_COLUMNS_PARTIAL',
] as const;

export type AuthBackfillViolationCode =
  (typeof AUTH_BACKFILL_VIOLATION_CODES)[number];

export interface AuthBackfillViolation {
  userId: string;
  violationCode: AuthBackfillViolationCode;
}

export interface AuthBackfillResult {
  mode: AuthBackfillMode;
  totalRows: number;
  plannedUpdateRows: number;
  updatedRows: number;
}

export class AuthBackfillError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthBackfillError';
    this.code = code;
  }
}

export class AuthBackfillDataError extends AuthBackfillError {
  readonly #violations: readonly AuthBackfillViolation[];
  readonly totalRows: number;
  readonly plannedUpdateRows: number;

  constructor(
    violations: readonly AuthBackfillViolation[],
    totalRows: number,
    plannedUpdateRows: number,
  ) {
    const counts = new Map<AuthBackfillViolationCode, number>();
    for (const { violationCode } of violations) {
      counts.set(violationCode, (counts.get(violationCode) ?? 0) + 1);
    }
    super(
      'MINETENANT_AUTH_BACKFILL_DATA_INVALID',
      `Auth backfill validation failed: total=${totalRows} planned=${plannedUpdateRows} violationCounts=${JSON.stringify(Object.fromEntries(counts))}.`,
    );
    this.name = 'AuthBackfillDataError';
    this.#violations = violations.map((violation) => ({ ...violation }));
    this.totalRows = totalRows;
    this.plannedUpdateRows = plannedUpdateRows;
  }

  get violations(): readonly AuthBackfillViolation[] {
    return this.#violations;
  }
}

interface AuthUserRow {
  userId: string;
  name: string | null;
  email: string | null;
  password: string | null;
  role: string;
  roleLabel: string | null;
  avatarInitial: string | null;
  username: string | null;
  displayName: string | null;
  passwordHash: string | null;
}

interface SessionStateRow {
  timeZone: string | null;
  sqlMode: string | null;
}

interface CurrentDatabaseRow {
  databaseName: string | null;
}

interface LockRow {
  result: number | string | null;
}

interface PlannedUser {
  row: AuthUserRow;
  username?: string;
  displayName?: string;
  passwordHash?: string;
}

interface Analysis {
  rows: readonly AuthUserRow[];
  plans: readonly PlannedUser[];
  violations: readonly AuthBackfillViolation[];
  plannedUpdateRows: number;
}

const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/u;
const PASSWORD_HASH_PATTERN = /^\$2[by]\$(0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/u;
const SYNTHETIC_EMAIL_PATTERN = /^legacy\+[0-9a-f]{48}@legacy\.invalid$/u;
const FIXED_USERNAMES = new Map([
  ['user-buyer', 'demo'],
  ['user-seller', 'seller'],
]);
const RESERVED_USERNAME_OWNERS = new Map([
  ['demo', 'user-buyer'],
  ['seller', 'user-seller'],
]);

function operationalFailure(code: string, message: string): never {
  throw new AuthBackfillError(code, message);
}

function isValidPasswordHash(value: string): boolean {
  if (!PASSWORD_HASH_PATTERN.test(value)) return false;
  try {
    const normalized = value.startsWith('$2y$')
      ? `$2b$${value.slice(4)}`
      : value;
    const rounds = bcrypt.getRounds(normalized);
    return Number.isInteger(rounds) && rounds >= 4 && rounds <= 16;
  } catch {
    return false;
  }
}

function codePointLength(value: string): number {
  return [...value].length;
}

function firstCodePoint(value: string): string {
  return [...value][0] ?? '';
}

export function usernameCandidate(userId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 99) {
    throw new RangeError('Username attempt must be an integer from 0 to 99.');
  }
  return `u_${createHash('sha256')
    .update(`${userId}:${attempt}`, 'utf8')
    .digest('hex')
    .slice(0, 30)}`;
}

export function syntheticEmailCandidate(
  userId: string,
  attempt: number,
): string {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 99) {
    throw new RangeError(
      'Synthetic email attempt must be an integer from 0 to 99.',
    );
  }
  return `legacy+${createHash('sha256')
    .update(`${userId}:${attempt}`, 'utf8')
    .digest('hex')
    .slice(0, 48)}@legacy.invalid`;
}

function binaryUserIdOrder(left: AuthUserRow, right: AuthUserRow): number {
  return Buffer.compare(
    Buffer.from(left.userId, 'utf8'),
    Buffer.from(right.userId, 'utf8'),
  );
}

function analyzeRows(rowsInput: readonly AuthUserRow[]): Analysis {
  const rows = [...rowsInput].sort(binaryUserIdOrder);
  const violations: AuthBackfillViolation[] = [];
  const violationKeys = new Set<string>();
  const addViolation = (
    userId: string,
    violationCode: AuthBackfillViolationCode,
  ) => {
    const key = `${userId}\0${violationCode}`;
    if (violationKeys.has(key)) return;
    violationKeys.add(key);
    violations.push({ userId, violationCode });
  };

  const owners = new Map<string, string[]>();
  for (const row of rows) {
    if (row.username === null) continue;
    const current = owners.get(row.username) ?? [];
    current.push(row.userId);
    owners.set(row.username, current);
    if (!USERNAME_PATTERN.test(row.username)) {
      addViolation(row.userId, 'USERNAME_INVALID');
    }
    const reservedOwner = RESERVED_USERNAME_OWNERS.get(row.username);
    if (reservedOwner !== undefined && reservedOwner !== row.userId) {
      addViolation(row.userId, 'RESERVED_USERNAME_OWNER_INVALID');
    }
  }
  for (const duplicateOwners of owners.values()) {
    if (duplicateOwners.length < 2) continue;
    for (const userId of duplicateOwners) {
      addViolation(userId, 'USERNAME_DUPLICATE');
    }
  }

  for (const [fixedUserId, fixedUsername] of FIXED_USERNAMES) {
    const row = rows.find(({ userId }) => userId === fixedUserId);
    if (
      row !== undefined &&
      row.username !== null &&
      row.username !== fixedUsername
    ) {
      addViolation(fixedUserId, 'FIXED_USERNAME_MISMATCH');
    }
    const reservedOwners = owners.get(fixedUsername) ?? [];
    if (reservedOwners.some((owner) => owner !== fixedUserId)) {
      if (row) addViolation(row.userId, 'RESERVED_USERNAME_OWNER_INVALID');
    }
  }

  const occupied = new Set(owners.keys());
  const plans: PlannedUser[] = [];
  for (const row of rows) {
    let username = row.username ?? undefined;
    if (username === undefined) {
      const fixed = FIXED_USERNAMES.get(row.userId);
      if (fixed !== undefined) {
        const conflictingOwners = owners.get(fixed) ?? [];
        if (conflictingOwners.some((owner) => owner !== row.userId)) {
          addViolation(row.userId, 'RESERVED_USERNAME_OWNER_INVALID');
        } else {
          username = fixed;
          occupied.add(fixed);
        }
      } else {
        for (let attempt = 0; attempt <= 99; attempt += 1) {
          const candidate = usernameCandidate(row.userId, attempt);
          if (occupied.has(candidate)) continue;
          username = candidate;
          occupied.add(candidate);
          break;
        }
        if (username === undefined) {
          addViolation(row.userId, 'USERNAME_GENERATION_EXHAUSTED');
        }
      }
    }

    if (
      row.name === null ||
      row.email === null ||
      row.password === null ||
      row.roleLabel === null ||
      row.avatarInitial === null
    ) {
      addViolation(row.userId, 'LEGACY_COMPATIBILITY_INCOMPLETE');
    }
    if (row.role !== 'buyer' && row.role !== 'seller') {
      addViolation(row.userId, 'ROLE_INVALID');
    }

    const legacyDisplayName = (row.name ?? '').trim();
    if (
      legacyDisplayName.length > 0 &&
      codePointLength(legacyDisplayName) > 120
    ) {
      addViolation(row.userId, 'DISPLAY_NAME_INVALID');
    }
    let displayName = row.displayName ?? undefined;
    if (displayName === undefined && username !== undefined) {
      displayName = legacyDisplayName || username;
    }
    if (
      displayName !== undefined &&
      (displayName !== displayName.trim() ||
        codePointLength(displayName) < 1 ||
        codePointLength(displayName) > 120)
    ) {
      addViolation(row.userId, 'DISPLAY_NAME_INVALID');
    }

    let passwordHash = row.passwordHash ?? undefined;
    if (row.password === null || !isValidPasswordHash(row.password)) {
      addViolation(row.userId, 'PASSWORD_HASH_INVALID');
    } else if (passwordHash === undefined) {
      passwordHash = row.password;
    }
    if (passwordHash !== undefined && !isValidPasswordHash(passwordHash)) {
      addViolation(row.userId, 'PASSWORD_HASH_INVALID');
    }
    if (
      row.password !== null &&
      passwordHash !== undefined &&
      Buffer.compare(
        Buffer.from(row.password, 'utf8'),
        Buffer.from(passwordHash, 'utf8'),
      ) !== 0
    ) {
      addViolation(row.userId, 'PASSWORD_HASH_MISMATCH');
    }

    if (row.email !== null && SYNTHETIC_EMAIL_PATTERN.test(row.email)) {
      let reproducible = false;
      for (let attempt = 0; attempt <= 99; attempt += 1) {
        if (syntheticEmailCandidate(row.userId, attempt) === row.email) {
          reproducible = true;
          break;
        }
      }
      if (!reproducible) {
        addViolation(row.userId, 'SYNTHETIC_EMAIL_INVALID');
      }
      const expectedRoleLabel =
        row.role === 'buyer'
          ? '購入者'
          : row.role === 'seller'
            ? '出品者'
            : undefined;
      if (
        displayName === undefined ||
        passwordHash === undefined ||
        row.name !== displayName ||
        row.password !== passwordHash ||
        expectedRoleLabel === undefined ||
        row.roleLabel !== expectedRoleLabel ||
        row.avatarInitial !== firstCodePoint(displayName)
      ) {
        addViolation(row.userId, 'SYNTHETIC_COMPATIBILITY_MISMATCH');
      }
    }

    plans.push({ row, username, displayName, passwordHash });
  }

  return {
    rows,
    plans,
    violations,
    plannedUpdateRows: plans.filter(
      ({ row }) =>
        row.username === null ||
        row.displayName === null ||
        row.passwordHash === null,
    ).length,
  };
}

function withCompletenessViolations(
  analysis: Analysis,
  kind: 'complete' | 'migration',
): Analysis {
  const violations = [...analysis.violations];
  const keys = new Set(
    violations.map(
      ({ userId, violationCode }) => `${userId}\0${violationCode}`,
    ),
  );
  for (const row of analysis.rows) {
    const nullCount = [row.username, row.displayName, row.passwordHash].filter(
      (value) => value === null,
    ).length;
    const code =
      kind === 'complete'
        ? nullCount > 0
          ? 'NEW_COLUMNS_INCOMPLETE'
          : undefined
        : nullCount > 0 && nullCount < 3
          ? 'NEW_COLUMNS_PARTIAL'
          : undefined;
    if (code === undefined) continue;
    const key = `${row.userId}\0${code}`;
    if (keys.has(key)) continue;
    keys.add(key);
    violations.push({ userId: row.userId, violationCode: code });
  }
  return { ...analysis, violations };
}

function throwIfInvalid(analysis: Analysis): void {
  if (analysis.violations.length === 0) return;
  throw new AuthBackfillDataError(
    analysis.violations,
    analysis.rows.length,
    analysis.plannedUpdateRows,
  );
}

async function readRows(
  db: SqlExecutor,
  forUpdate: boolean,
): Promise<AuthUserRow[]> {
  return db.query<AuthUserRow>(
    `SELECT user_id AS userId, name, email, password, role,
            role_label AS roleLabel, avatar_initial AS avatarInitial,
            username, display_name AS displayName,
            password_hash AS passwordHash
       FROM users
      ORDER BY BINARY user_id${forUpdate ? ' FOR UPDATE' : ''}`,
  );
}

export async function prepareAuthBackfillSession(
  db: SqlExecutor,
): Promise<void> {
  await db.execute("SET SESSION time_zone = '+00:00'");
  const [state] = await db.query<SessionStateRow>(
    `SELECT @@SESSION.time_zone AS timeZone,
            @@SESSION.sql_mode AS sqlMode`,
  );
  const modes = new Set(
    (state?.sqlMode ?? '')
      .split(',')
      .map((mode) => mode.trim().toUpperCase())
      .filter(Boolean),
  );
  if (state?.timeZone !== '+00:00') {
    operationalFailure(
      'MINETENANT_AUTH_BACKFILL_UTC_REQUIRED',
      'The auth backfill connection is not pinned to UTC.',
    );
  }
  if (!modes.has('STRICT_TRANS_TABLES') && !modes.has('STRICT_ALL_TABLES')) {
    operationalFailure(
      'MINETENANT_AUTH_BACKFILL_STRICT_MODE_REQUIRED',
      'The auth backfill connection requires a strict SQL mode.',
    );
  }
}

export async function applyAuthBackfill(
  db: MigrationExecutor,
): Promise<AuthBackfillResult> {
  await db.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  return db.transaction(async (tx) => {
    const before = analyzeRows(await readRows(tx, true));
    throwIfInvalid(before);

    let updatedRows = 0;
    for (const plan of before.plans) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (plan.row.username === null && plan.username !== undefined) {
        assignments.push('username = ?');
        values.push(plan.username);
      }
      if (plan.row.displayName === null && plan.displayName !== undefined) {
        assignments.push('display_name = ?');
        values.push(plan.displayName);
      }
      if (plan.row.passwordHash === null && plan.passwordHash !== undefined) {
        assignments.push('password_hash = ?');
        values.push(plan.passwordHash);
      }
      if (assignments.length === 0) continue;
      values.push(plan.row.userId);
      const result = await tx.execute(
        `UPDATE users SET ${assignments.join(', ')} WHERE user_id = ?`,
        values,
      );
      if (result.affectedRows !== 1) {
        operationalFailure(
          'MINETENANT_AUTH_BACKFILL_UPDATE_FAILED',
          'An auth backfill row could not be updated exactly once.',
        );
      }
      updatedRows += 1;
    }

    const after = withCompletenessViolations(
      analyzeRows(await readRows(tx, false)),
      'complete',
    );
    throwIfInvalid(after);
    return {
      mode: 'apply',
      totalRows: after.rows.length,
      plannedUpdateRows: before.plannedUpdateRows,
      updatedRows,
    };
  });
}

export async function checkAuthBackfill(
  db: MigrationExecutor,
): Promise<AuthBackfillResult> {
  await db.execute('SET TRANSACTION READ ONLY');
  return db.transaction(async (tx) => {
    const analysis = withCompletenessViolations(
      analyzeRows(await readRows(tx, false)),
      'complete',
    );
    throwIfInvalid(analysis);
    return {
      mode: 'check',
      totalRows: analysis.rows.length,
      plannedUpdateRows: analysis.plannedUpdateRows,
      updatedRows: 0,
    };
  });
}

export async function verifyMigrationAuthData(db: SqlExecutor): Promise<void> {
  const analysis = withCompletenessViolations(
    analyzeRows(await readRows(db, false)),
    'migration',
  );
  throwIfInvalid(analysis);
}

export async function validateAuthBackfillInput(
  db: SqlExecutor,
): Promise<void> {
  throwIfInvalid(analyzeRows(await readRows(db, false)));
}

export function authBackfillLockName(databaseName: string): string {
  const hash = createHash('sha256')
    .update(databaseName.toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `minetenant:auth-backfill:v1:${hash}`;
}

export async function runAuthBackfill(
  database: Database,
  mode: AuthBackfillMode,
): Promise<AuthBackfillResult> {
  return database.withConnection(async (db, lease) => {
    const [current] = await db.query<CurrentDatabaseRow>(
      'SELECT DATABASE() AS databaseName',
    );
    if (!current?.databaseName) {
      operationalFailure(
        'MINETENANT_AUTH_BACKFILL_DATABASE_REQUIRED',
        'A database must be selected before auth backfill.',
      );
    }

    const lockName = authBackfillLockName(current.databaseName);
    let lock: LockRow | undefined;
    try {
      [lock] = await db.query<LockRow>('SELECT GET_LOCK(?, 0) AS result', [
        lockName,
      ]);
    } catch (error) {
      // The server may have acquired the lock before the response was lost.
      // Closing this physical connection is the only reliable release path.
      lease.discard();
      throw error;
    }
    if (Number(lock?.result) !== 1) {
      operationalFailure(
        'MINETENANT_AUTH_BACKFILL_LOCK_UNAVAILABLE',
        'Another auth backfill command holds the database lock.',
      );
    }

    let result: AuthBackfillResult | undefined;
    let failure: unknown;
    try {
      await prepareAuthBackfillSession(db);
      await assertAuthBackfillCommandReady(db);
      result =
        mode === 'apply'
          ? await applyAuthBackfill(db)
          : await checkAuthBackfill(db);
    } catch (error) {
      failure = error;
    }

    try {
      const [released] = await db.query<LockRow>(
        'SELECT RELEASE_LOCK(?) AS result',
        [lockName],
      );
      if (Number(released?.result) !== 1) {
        operationalFailure(
          'MINETENANT_AUTH_BACKFILL_LOCK_RELEASE_FAILED',
          'The auth backfill lock could not be released.',
        );
      }
    } catch (error) {
      lease.discard();
      if (failure === undefined) failure = error;
    }

    if (failure !== undefined) throw failure;
    if (result === undefined) {
      operationalFailure(
        'MINETENANT_AUTH_BACKFILL_FAILED',
        'Auth backfill finished without a result.',
      );
    }
    return result;
  });
}

export function countAuthBackfillViolations(
  violations: readonly AuthBackfillViolation[],
): Readonly<Record<AuthBackfillViolationCode, number>> {
  const counts = Object.fromEntries(
    AUTH_BACKFILL_VIOLATION_CODES.map((code) => [code, 0]),
  ) as Record<AuthBackfillViolationCode, number>;
  for (const { violationCode } of violations) counts[violationCode] += 1;
  return counts;
}
