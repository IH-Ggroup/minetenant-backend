import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authBackfillErrorCode,
  executeAuthBackfill,
  parseAuthBackfillArguments,
  writeAuthBackfillReport,
} from '../scripts/auth-backfill.js';
import { migrate } from '../scripts/migrate.js';
import { seedDemo } from '../scripts/seed.js';
import type { Database, MigrationExecutor, SqlExecutor } from '../src/db.js';
import {
  applyAuthBackfill,
  authBackfillLockName,
  AuthBackfillDataError,
  runAuthBackfill,
  syntheticEmailCandidate,
  usernameCandidate,
  type AuthBackfillViolation,
} from '../src/db/auth-backfill.js';
import {
  AUTH_USERNAME_INDEX,
  AuthSchemaMigrationError,
  expandAuthSchema,
  inspectAuthSchema,
} from '../src/db/auth-schema.js';
import {
  entityIdColumnsMigration,
  initialSchemaMigration,
  migrations,
  productStatusMigration,
  runMigrations,
  usernameAuthMigration,
} from '../src/db/migrations/index.js';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
} from './helpers.js';

const TEST_DATABASE = 'minetenant_test';
const VALID_HASH =
  '$2b$04$li0g2OT/y7U.0JQbXnC3euNhv2yFedgp/gBodO383UCSuOkZ3Var2';
const VALID_2Y_HASH = VALID_HASH.replace('$2b$', '$2y$');
const PRE_AUTH_MIGRATIONS = [
  initialSchemaMigration,
  entityIdColumnsMigration,
  productStatusMigration,
] as const;
const APPLICATION_TABLES = [
  'product_status_migration_request_audit',
  'product_status_migration_product_audit',
  'purchase_transactions',
  'hono_sessions',
  'products',
  'stores',
  'hono_rate_limits',
  'users',
  'schema_migrations',
] as const;

interface LegacyUserInput {
  userId: string;
  name?: string;
  email?: string;
  password?: string;
  role?: string;
  roleLabel?: string;
  avatarInitial?: string;
}

async function assertTestDatabase(db: SqlExecutor): Promise<void> {
  const [row] = await db.query<{ databaseName: string | null }>(
    'SELECT DATABASE() AS databaseName',
  );
  assert.equal(row?.databaseName, TEST_DATABASE);
}

async function dropApplicationSchema(db: Database): Promise<void> {
  await assertTestDatabase(db);
  for (const table of APPLICATION_TABLES) {
    await db.execute(`DROP TABLE IF EXISTS \`${table}\``);
  }
}

async function preparePreAuthSchema(db: Database): Promise<void> {
  await dropApplicationSchema(db);
  await runMigrations(db, PRE_AUTH_MIGRATIONS);
}

async function prepareCurrentEmptySchema(db: Database): Promise<void> {
  await dropApplicationSchema(db);
  await migrate(db);
}

async function restoreCurrentSchema(db: Database): Promise<void> {
  await prepareCurrentEmptySchema(db);
  await seedDemo(db, 4);
}

async function insertLegacyUser(
  db: SqlExecutor,
  input: LegacyUserInput,
): Promise<void> {
  await db.execute(
    `INSERT INTO users
      (user_id, name, email, password, role, role_label, avatar_initial)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.name ?? input.userId,
      input.email ?? `${input.userId}@example.test`,
      input.password ?? VALID_HASH,
      input.role ?? 'buyer',
      input.roleLabel ?? '購入者',
      input.avatarInitial ?? '利',
    ],
  );
}

async function userForeignKeys(db: SqlExecutor) {
  return db.query(
    `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
            COLUMN_NAME AS columnName,
            REFERENCED_COLUMN_NAME AS referencedColumnName
       FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE()
        AND referenced_table_schema = DATABASE()
        AND referenced_table_name = 'users'
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
  );
}

async function appliedVersions(db: SqlExecutor): Promise<string[]> {
  const rows = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return rows.map(({ version }) => version);
}

async function withPinnedConnection<T>(
  db: Database,
  fn: (connection: MigrationExecutor) => Promise<T>,
): Promise<T> {
  return db.withConnection((connection) => fn(connection));
}

function connectionOnlyDatabase(
  db: Database,
  wrap: (
    connection: MigrationExecutor,
    lease: { discard(): void },
  ) => {
    connection: MigrationExecutor;
    lease: { discard(): void };
  },
): Database {
  return {
    query: db.query.bind(db),
    execute: db.execute.bind(db),
    transaction: db.transaction.bind(db),
    close: async () => undefined,
    withConnection: (fn) =>
      db.withConnection((connection, lease) => {
        const wrapped = wrap(connection, lease);
        return fn(wrapped.connection, wrapped.lease);
      }),
  };
}

describe('0003 username auth migration and catch-up command', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });

  beforeEach(async () => {
    await preparePreAuthSchema(test.db);
  });

  afterAll(async () => {
    if (!test) return;
    try {
      await restoreCurrentSchema(test.db);
    } finally {
      await test.close();
    }
  });

  it('expands an empty users table with exact nullable columns and UNIQUE index', async () => {
    const foreignKeysBefore = await userForeignKeys(test.db);
    await migrate(test.db);

    const columns = await test.db.query<{
      columnName: string;
      columnType: string;
      isNullable: string;
      characterSetName: string | null;
      collationName: string | null;
      columnDefault: string | null;
    }>(
      `SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
              IS_NULLABLE AS isNullable,
              CHARACTER_SET_NAME AS characterSetName,
              COLLATION_NAME AS collationName,
              COLUMN_DEFAULT AS columnDefault
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'users'
        ORDER BY ORDINAL_POSITION`,
    );
    const byName = new Map(
      columns.map((column) => [column.columnName, column]),
    );
    expect(byName.get('username')).toMatchObject({
      columnType: 'varchar(32)',
      isNullable: 'YES',
      characterSetName: 'ascii',
      collationName: 'ascii_bin',
      columnDefault: null,
    });
    expect(byName.get('display_name')).toMatchObject({
      columnType: 'varchar(120)',
      isNullable: 'YES',
      characterSetName: 'utf8mb4',
      collationName: 'utf8mb4_unicode_ci',
      columnDefault: null,
    });
    expect(byName.get('password_hash')).toMatchObject({
      columnType: 'varchar(255)',
      isNullable: 'YES',
      characterSetName: 'utf8mb4',
      collationName: 'utf8mb4_unicode_ci',
      columnDefault: null,
    });
    for (const legacy of [
      'name',
      'email',
      'password',
      'role_label',
      'avatar_initial',
    ]) {
      expect(byName.get(legacy)?.isNullable).toBe('YES');
    }
    expect(
      await test.db.query(
        `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
                GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
           FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'users'
          GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME`,
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          indexName: AUTH_USERNAME_INDEX,
          nonUnique: 0,
          columns: 'username',
        },
      ]),
    );
    expect(await userForeignKeys(test.db)).toEqual(foreignKeysBefore);
    expect(await appliedVersions(test.db)).toEqual(
      migrations.map(({ version }) => version),
    );

    const before = await test.db.query('SHOW CREATE TABLE users');
    await migrate(test.db);
    expect(await test.db.query('SHOW CREATE TABLE users')).toEqual(before);
  });

  it('deterministically backfills fixed and generated users without changing legacy auth', async () => {
    await insertLegacyUser(test.db, {
      userId: 'user-buyer',
      name: '　山田 みどり　',
      email: 'buyer@example.test',
    });
    await insertLegacyUser(test.db, {
      userId: 'user-seller',
      name: '',
      email: 'seller@example.test',
      password: VALID_2Y_HASH,
      role: 'seller',
      roleLabel: '出品者デモ',
      avatarInitial: 'M',
    });
    await insertLegacyUser(test.db, {
      userId: 'legacy-user',
      name: '  移行利用者  ',
      email: 'legacy@example.test',
    });
    await test.db.execute(
      `INSERT INTO stores
        (store_id, user_id, name, description, level, points, sync_status)
       VALUES ('legacy-store', 'legacy-user', '既存店舗', '', 1, 0, 'offline')`,
    );
    const foreignKeysBefore = await userForeignKeys(test.db);
    const passwordsBefore = await test.db.query(
      'SELECT user_id, password FROM users ORDER BY BINARY user_id',
    );

    await migrate(test.db);

    expect(
      await test.db.query(
        `SELECT user_id, username, display_name, password_hash
           FROM users ORDER BY BINARY user_id`,
      ),
    ).toEqual([
      {
        user_id: 'legacy-user',
        username: usernameCandidate('legacy-user', 0),
        display_name: '移行利用者',
        password_hash: VALID_HASH,
      },
      {
        user_id: 'user-buyer',
        username: 'demo',
        display_name: '山田 みどり',
        password_hash: VALID_HASH,
      },
      {
        user_id: 'user-seller',
        username: 'seller',
        display_name: 'seller',
        password_hash: VALID_2Y_HASH,
      },
    ]);
    expect(
      await test.db.query(
        'SELECT user_id, password FROM users ORDER BY BINARY user_id',
      ),
    ).toEqual(passwordsBefore);
    expect(await userForeignKeys(test.db)).toEqual(foreignKeysBefore);
    expect(await test.db.query('SELECT store_id, user_id FROM stores')).toEqual(
      [{ store_id: 'legacy-store', user_id: 'legacy-user' }],
    );

    const client = createClient(test.app);
    await expectStatus(
      await client.login('buyer@example.test', 'migration-password'),
      200,
    );
  });

  it('catches up rows written after migration history and remains idempotent', async () => {
    await migrate(test.db);
    await insertLegacyUser(test.db, {
      userId: 'late-user',
      name: '  遅延利用者  ',
      email: 'late@example.test',
    });

    await expect(runAuthBackfill(test.db, 'check')).rejects.toMatchObject({
      code: 'MINETENANT_AUTH_BACKFILL_DATA_INVALID',
      plannedUpdateRows: 1,
    });
    await expect(runAuthBackfill(test.db, 'apply')).resolves.toMatchObject({
      totalRows: 1,
      plannedUpdateRows: 1,
      updatedRows: 1,
    });
    await expect(runAuthBackfill(test.db, 'apply')).resolves.toMatchObject({
      plannedUpdateRows: 0,
      updatedRows: 0,
    });
    await expect(runAuthBackfill(test.db, 'check')).resolves.toMatchObject({
      totalRows: 1,
      updatedRows: 0,
    });
    expect(
      await test.db.query(
        `SELECT username, display_name, password_hash, password
           FROM users WHERE user_id = 'late-user'`,
      ),
    ).toEqual([
      {
        username: usernameCandidate('late-user', 0),
        display_name: '遅延利用者',
        password_hash: VALID_HASH,
        password: VALID_HASH,
      },
    ]);
  });

  it('rolls back every row when validation fails after additive DDL', async () => {
    await insertLegacyUser(test.db, { userId: 'valid-user' });
    await insertLegacyUser(test.db, {
      userId: 'invalid-user',
      password: VALID_HASH.replace('$2b$', '$2a$'),
    });

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_AUTH_BACKFILL_DATA_INVALID',
    });
    expect((await inspectAuthSchema(test.db)).expanded).toBe(true);
    expect((await inspectAuthSchema(test.db)).usernameIndexPresent).toBe(false);
    expect(
      await test.db.query(
        `SELECT user_id, username, display_name, password_hash
           FROM users ORDER BY BINARY user_id`,
      ),
    ).toEqual([
      {
        user_id: 'invalid-user',
        username: null,
        display_name: null,
        password_hash: null,
      },
      {
        user_id: 'valid-user',
        username: null,
        display_name: null,
        password_hash: null,
      },
    ]);
    expect(await appliedVersions(test.db)).toEqual(
      PRE_AUTH_MIGRATIONS.map(({ version }) => version),
    );

    await test.db.execute(
      "UPDATE users SET password = ? WHERE user_id = 'invalid-user'",
      [VALID_HASH],
    );
    await expect(migrate(test.db)).resolves.toBeUndefined();
  });

  it('rolls back earlier updates when a later row update fails', async () => {
    await insertLegacyUser(test.db, { userId: 'rollback-a' });
    await insertLegacyUser(test.db, { userId: 'rollback-b' });
    await withPinnedConnection(test.db, (connection) =>
      expandAuthSchema(connection),
    );

    let updateCount = 0;
    await expect(
      test.db.withConnection((connection) => {
        const failingConnection: MigrationExecutor = {
          query: connection.query.bind(connection),
          execute: connection.execute.bind(connection),
          transaction: (fn) =>
            connection.transaction((tx) =>
              fn({
                query: tx.query.bind(tx),
                async execute(sql: string, params?: unknown[]) {
                  if (sql.startsWith('UPDATE users SET')) {
                    updateCount += 1;
                    if (updateCount === 2) {
                      throw new Error('intentional second-row update failure');
                    }
                  }
                  return tx.execute(sql, params);
                },
              }),
            ),
        };
        return applyAuthBackfill(failingConnection);
      }),
    ).rejects.toThrow('intentional second-row update failure');
    expect(updateCount).toBe(2);
    expect(
      await test.db.query(
        `SELECT user_id, username, display_name, password_hash
           FROM users ORDER BY BINARY user_id`,
      ),
    ).toEqual([
      {
        user_id: 'rollback-a',
        username: null,
        display_name: null,
        password_hash: null,
      },
      {
        user_id: 'rollback-b',
        username: null,
        display_name: null,
        password_hash: null,
      },
    ]);
  });

  it('resumes after expand DDL, backfill commit, and an unrecorded completed up', async () => {
    await insertLegacyUser(test.db, { userId: 'restart-user' });
    const failBeforeDml: MigrationExecutor = {
      query: test.db.query.bind(test.db),
      execute: test.db.execute.bind(test.db),
      transaction: async () => {
        throw new Error('intentional failure before auth backfill DML');
      },
    };
    await expect(usernameAuthMigration.up(failBeforeDml)).rejects.toThrow(
      'intentional failure before auth backfill DML',
    );
    expect(await inspectAuthSchema(test.db)).toMatchObject({
      expanded: true,
      legacyColumnsNullable: true,
      usernameIndexPresent: false,
    });
    await expect(migrate(test.db)).resolves.toBeUndefined();

    await preparePreAuthSchema(test.db);
    await insertLegacyUser(test.db, { userId: 'index-restart-user' });
    let blocked = false;
    const failBeforeIndex: MigrationExecutor = {
      query: test.db.query.bind(test.db),
      transaction: test.db.transaction.bind(test.db),
      async execute(sql, params) {
        if (sql.includes(`ADD UNIQUE INDEX \`${AUTH_USERNAME_INDEX}\``)) {
          blocked = true;
          throw new Error('intentional failure before username index');
        }
        return test.db.execute(sql, params);
      },
    };
    await expect(usernameAuthMigration.up(failBeforeIndex)).rejects.toThrow(
      'intentional failure before username index',
    );
    expect(blocked).toBe(true);
    expect(
      await test.db.query(
        "SELECT username FROM users WHERE user_id = 'index-restart-user'",
      ),
    ).toEqual([{ username: usernameCandidate('index-restart-user', 0) }]);
    expect((await inspectAuthSchema(test.db)).usernameIndexPresent).toBe(false);
    await expect(migrate(test.db)).resolves.toBeUndefined();

    await preparePreAuthSchema(test.db);
    await insertLegacyUser(test.db, { userId: 'history-restart-user' });
    await withPinnedConnection(test.db, async (connection) => {
      await usernameAuthMigration.preflight(connection);
      await usernameAuthMigration.up(connection);
      await usernameAuthMigration.verify(connection);
    });
    expect(await appliedVersions(test.db)).toEqual(
      PRE_AUTH_MIGRATIONS.map(({ version }) => version),
    );
    await expect(migrate(test.db)).resolves.toBeUndefined();
  });

  it('preserves valid partial values and fills only missing auth columns', async () => {
    await insertLegacyUser(test.db, { userId: 'partial-user' });
    await withPinnedConnection(test.db, (connection) =>
      expandAuthSchema(connection),
    );
    await test.db.execute(
      "UPDATE users SET username = 'chosen_name' WHERE user_id = 'partial-user'",
    );

    await expect(migrate(test.db)).resolves.toBeUndefined();
    expect(
      await test.db.query(
        `SELECT username, display_name, password_hash
           FROM users WHERE user_id = 'partial-user'`,
      ),
    ).toEqual([
      {
        username: 'chosen_name',
        display_name: 'partial-user',
        password_hash: VALID_HASH,
      },
    ]);
  });

  it('uses the next deterministic username candidate and fails after attempt 99', async () => {
    await insertLegacyUser(test.db, { userId: 'collision-target' });
    await insertLegacyUser(test.db, { userId: 'collision-blocker' });
    await withPinnedConnection(test.db, (connection) =>
      expandAuthSchema(connection),
    );
    await test.db.execute(
      `UPDATE users
          SET username = ?, display_name = name, password_hash = password
        WHERE user_id = 'collision-blocker'`,
      [usernameCandidate('collision-target', 0)],
    );
    await withPinnedConnection(test.db, (connection) =>
      applyAuthBackfill(connection),
    );
    expect(
      await test.db.query(
        "SELECT username FROM users WHERE user_id = 'collision-target'",
      ),
    ).toEqual([{ username: usernameCandidate('collision-target', 1) }]);

    await preparePreAuthSchema(test.db);
    await insertLegacyUser(test.db, { userId: 'exhausted-target' });
    for (let attempt = 0; attempt <= 99; attempt += 1) {
      await insertLegacyUser(test.db, {
        userId: `blocker-${attempt.toString().padStart(3, '0')}`,
      });
    }
    await withPinnedConnection(test.db, (connection) =>
      expandAuthSchema(connection),
    );
    for (let attempt = 0; attempt <= 99; attempt += 1) {
      await test.db.execute(
        `UPDATE users
            SET username = ?, display_name = name, password_hash = password
          WHERE user_id = ?`,
        [
          usernameCandidate('exhausted-target', attempt),
          `blocker-${attempt.toString().padStart(3, '0')}`,
        ],
      );
    }
    const error = await withPinnedConnection(test.db, (connection) =>
      applyAuthBackfill(connection).catch((caught: unknown) => caught),
    );
    expect(error).toBeInstanceOf(AuthBackfillDataError);
    expect((error as AuthBackfillDataError).violations).toContainEqual({
      userId: 'exhausted-target',
      violationCode: 'USERNAME_GENERATION_EXHAUSTED',
    });
    expect(
      await test.db.query(
        "SELECT username FROM users WHERE user_id = 'exhausted-target'",
      ),
    ).toEqual([{ username: null }]);
  });

  it('fails closed for reserved names, duplicates, invalid fields, and synthetic incompatibility', async () => {
    const users = [
      'user-buyer',
      'reserved-owner',
      'duplicate-a',
      'duplicate-b',
      'invalid-name',
      'invalid-role',
      'invalid-display',
      'invalid-hash',
      'hash-mismatch',
      'synthetic-user',
      'rollback-witness',
    ];
    for (const userId of users) await insertLegacyUser(test.db, { userId });
    await withPinnedConnection(test.db, (connection) =>
      expandAuthSchema(connection),
    );
    await test.db.execute(
      `UPDATE users SET username = 'wrong_fixed'
        WHERE user_id = 'user-buyer'`,
    );
    await test.db.execute(
      `UPDATE users SET username = 'demo'
        WHERE user_id = 'reserved-owner'`,
    );
    await test.db.execute(
      `UPDATE users SET username = 'duplicate_name'
        WHERE user_id IN ('duplicate-a', 'duplicate-b')`,
    );
    await test.db.execute(
      `UPDATE users SET username = 'Invalid-Name'
        WHERE user_id = 'invalid-name'`,
    );
    await test.db.execute(
      `UPDATE users SET role = 'admin'
        WHERE user_id = 'invalid-role'`,
    );
    await test.db.execute(
      `UPDATE users SET display_name = ' bad '
        WHERE user_id = 'invalid-display'`,
    );
    await test.db.execute(
      `UPDATE users SET password = ?
        WHERE user_id = 'invalid-hash'`,
      [VALID_HASH.replace('$2b$', '$2a$')],
    );
    await test.db.execute(
      `UPDATE users SET password_hash = ?
        WHERE user_id = 'hash-mismatch'`,
      [VALID_2Y_HASH],
    );
    await test.db.execute(
      `UPDATE users
          SET email = ?, username = 'synthetic_name',
              display_name = 'Synthetic', password_hash = password
        WHERE user_id = 'synthetic-user'`,
      [syntheticEmailCandidate('synthetic-user', 0)],
    );

    const error = await withPinnedConnection(test.db, (connection) =>
      applyAuthBackfill(connection).catch((caught: unknown) => caught),
    );
    expect(error).toBeInstanceOf(AuthBackfillDataError);
    const codes = new Set(
      (error as AuthBackfillDataError).violations.map(
        ({ violationCode }) => violationCode,
      ),
    );
    expect([...codes]).toEqual(
      expect.arrayContaining([
        'FIXED_USERNAME_MISMATCH',
        'RESERVED_USERNAME_OWNER_INVALID',
        'USERNAME_DUPLICATE',
        'USERNAME_INVALID',
        'ROLE_INVALID',
        'DISPLAY_NAME_INVALID',
        'PASSWORD_HASH_INVALID',
        'PASSWORD_HASH_MISMATCH',
        'SYNTHETIC_COMPATIBILITY_MISMATCH',
      ]),
    );
    expect(
      await test.db.query(
        `SELECT username, display_name, password_hash
           FROM users WHERE user_id = 'rollback-witness'`,
      ),
    ).toEqual([{ username: null, display_name: null, password_hash: null }]);
  });

  it('counts display names by Unicode code point and validates synthetic rows', async () => {
    await insertLegacyUser(test.db, {
      userId: 'unicode-120',
      name: `\u3000${'😀'.repeat(120)}\u3000`,
    });
    await insertLegacyUser(test.db, {
      userId: 'synthetic-valid',
      name: 'Synthetic User',
      email: syntheticEmailCandidate('synthetic-valid', 0),
      role: 'seller',
      roleLabel: '出品者',
      avatarInitial: 'S',
    });
    await migrate(test.db);
    expect(
      await test.db.query(
        "SELECT CHAR_LENGTH(display_name) AS length FROM users WHERE user_id = 'unicode-120'",
      ),
    ).toEqual([{ length: 120 }]);

    await preparePreAuthSchema(test.db);
    await insertLegacyUser(test.db, {
      userId: 'unicode-121',
      name: '😀'.repeat(121),
    });
    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_AUTH_BACKFILL_DATA_INVALID',
    });
  });

  it('uses a non-blocking database-scoped lock on one pinned connection', async () => {
    await migrate(test.db);
    const lockName = authBackfillLockName(TEST_DATABASE);
    await test.db.withConnection(async (connection) => {
      expect(
        await connection.query('SELECT GET_LOCK(?, 0) AS result', [lockName]),
      ).toEqual([{ result: 1 }]);
      await expect(runAuthBackfill(test.db, 'check')).rejects.toMatchObject({
        code: 'MINETENANT_AUTH_BACKFILL_LOCK_UNAVAILABLE',
      });
      expect(
        await connection.query('SELECT RELEASE_LOCK(?) AS result', [lockName]),
      ).toEqual([{ result: 1 }]);
    });
    const databaseALock = authBackfillLockName('database-a');
    const databaseBLock = authBackfillLockName('database-b');
    expect(databaseALock).not.toBe(databaseBLock);
    await test.db.withConnection(async (databaseAConnection) => {
      await test.db.withConnection(async (databaseBConnection) => {
        expect(
          await databaseAConnection.query('SELECT GET_LOCK(?, 0) AS result', [
            databaseALock,
          ]),
        ).toEqual([{ result: 1 }]);
        try {
          expect(
            await databaseBConnection.query('SELECT GET_LOCK(?, 0) AS result', [
              databaseBLock,
            ]),
          ).toEqual([{ result: 1 }]);
        } finally {
          await databaseBConnection.query('SELECT RELEASE_LOCK(?) AS result', [
            databaseBLock,
          ]);
          await databaseAConnection.query('SELECT RELEASE_LOCK(?) AS result', [
            databaseALock,
          ]);
        }
      });
    });

    const connectionIds = new Set<number>();
    const tracked = connectionOnlyDatabase(test.db, (connection, lease) => {
      const record = async (executor: SqlExecutor) => {
        const [row] = await executor.query<{ id: number }>(
          'SELECT CONNECTION_ID() AS id',
        );
        connectionIds.add(row!.id);
      };
      const trackedConnection: MigrationExecutor = {
        async query<T extends object>(sql: string, params?: unknown[]) {
          await record(connection);
          return connection.query<T>(sql, params);
        },
        async execute(sql: string, params?: unknown[]) {
          await record(connection);
          return connection.execute(sql, params);
        },
        transaction: (fn) =>
          connection.transaction(async (tx) => {
            const trackedTx: SqlExecutor = {
              async query<T extends object>(sql: string, params?: unknown[]) {
                await record(tx);
                return tx.query<T>(sql, params);
              },
              async execute(sql: string, params?: unknown[]) {
                await record(tx);
                return tx.execute(sql, params);
              },
            };
            return fn(trackedTx);
          }),
      };
      return { connection: trackedConnection, lease };
    });
    await expect(runAuthBackfill(tracked, 'check')).resolves.toBeDefined();
    expect(connectionIds.size).toBe(1);

    let enteredCriticalSection!: () => void;
    let continueFirstCommand!: () => void;
    const criticalSectionEntered = new Promise<void>((resolve) => {
      enteredCriticalSection = resolve;
    });
    const firstCommandMayContinue = new Promise<void>((resolve) => {
      continueFirstCommand = resolve;
    });
    const delayedApply = connectionOnlyDatabase(
      test.db,
      (connection, lease) => ({
        connection: {
          ...connection,
          async execute(sql: string, params?: unknown[]) {
            if (sql.startsWith('SET SESSION time_zone')) {
              enteredCriticalSection();
              await firstCommandMayContinue;
            }
            return connection.execute(sql, params);
          },
        },
        lease,
      }),
    );
    const firstCommand = runAuthBackfill(delayedApply, 'apply');
    await criticalSectionEntered;
    try {
      await expect(runAuthBackfill(test.db, 'check')).rejects.toMatchObject({
        code: 'MINETENANT_AUTH_BACKFILL_LOCK_UNAVAILABLE',
      });
    } finally {
      continueFirstCommand();
    }
    await expect(firstCommand).resolves.toMatchObject({ mode: 'apply' });
  });

  it('fails before business queries without strict mode and discards on release failure', async () => {
    await migrate(test.db);
    let queriedUsers = false;
    const nonStrict = connectionOnlyDatabase(test.db, (connection, lease) => {
      // The test deliberately poisons this session; never return it to the pool.
      lease.discard();
      const wrapped: MigrationExecutor = {
        async query<T extends object>(sql: string, params?: unknown[]) {
          if (/\bFROM\s+users\b/iu.test(sql)) queriedUsers = true;
          return connection.query<T>(sql, params);
        },
        execute: connection.execute.bind(connection),
        transaction: connection.transaction.bind(connection),
      };
      return {
        connection: {
          ...wrapped,
          async execute(sql: string, params?: unknown[]) {
            if (sql.startsWith('SET SESSION time_zone')) {
              await connection.execute("SET SESSION sql_mode = ''");
            }
            return wrapped.execute(sql, params);
          },
        },
        lease: {
          discard() {
            lease.discard();
          },
        },
      };
    });
    await expect(runAuthBackfill(nonStrict, 'check')).rejects.toMatchObject({
      code: 'MINETENANT_AUTH_BACKFILL_STRICT_MODE_REQUIRED',
    });
    expect(queriedUsers).toBe(false);

    queriedUsers = false;
    const nonUtc = connectionOnlyDatabase(test.db, (connection, lease) => ({
      connection: {
        ...connection,
        async query<T extends object>(sql: string, params?: unknown[]) {
          if (/\bFROM\s+users\b/iu.test(sql)) queriedUsers = true;
          if (sql.includes('@@SESSION.time_zone')) {
            return [
              { timeZone: '+09:00', sqlMode: 'STRICT_TRANS_TABLES' },
            ] as T[];
          }
          return connection.query<T>(sql, params);
        },
      },
      lease,
    }));
    await expect(runAuthBackfill(nonUtc, 'check')).rejects.toMatchObject({
      code: 'MINETENANT_AUTH_BACKFILL_UTC_REQUIRED',
    });
    expect(queriedUsers).toBe(false);

    const sessionSetupFailure = connectionOnlyDatabase(
      test.db,
      (connection, lease) => ({
        connection: {
          ...connection,
          async execute(sql: string, params?: unknown[]) {
            if (sql.startsWith('SET SESSION time_zone')) {
              throw new Error('intentional session setup failure');
            }
            return connection.execute(sql, params);
          },
        },
        lease,
      }),
    );
    await expect(runAuthBackfill(sessionSetupFailure, 'check')).rejects.toThrow(
      'intentional session setup failure',
    );
    await expect(runAuthBackfill(test.db, 'check')).resolves.toBeDefined();

    let discarded = false;
    const releaseFailure = connectionOnlyDatabase(
      test.db,
      (connection, lease) => ({
        connection: {
          ...connection,
          async query<T extends object>(sql: string, params?: unknown[]) {
            if (sql.startsWith('SELECT RELEASE_LOCK')) {
              return [{ result: 0 }] as T[];
            }
            return connection.query<T>(sql, params);
          },
        },
        lease: {
          discard() {
            discarded = true;
            lease.discard();
          },
        },
      }),
    );
    await expect(
      runAuthBackfill(releaseFailure, 'check'),
    ).rejects.toMatchObject({
      code: 'MINETENANT_AUTH_BACKFILL_LOCK_RELEASE_FAILED',
    });
    expect(discarded).toBe(true);

    discarded = false;
    const releaseQueryFailure = connectionOnlyDatabase(
      test.db,
      (connection, lease) => ({
        connection: {
          ...connection,
          async query<T extends object>(sql: string, params?: unknown[]) {
            if (sql.startsWith('SELECT RELEASE_LOCK')) {
              throw new Error('intentional lock release query failure');
            }
            return connection.query<T>(sql, params);
          },
        },
        lease: {
          discard() {
            discarded = true;
            lease.discard();
          },
        },
      }),
    );
    await expect(runAuthBackfill(releaseQueryFailure, 'check')).rejects.toThrow(
      'intentional lock release query failure',
    );
    expect(discarded).toBe(true);
  });

  it('defaults to check and writes only secure non-overwriting violation reports', async () => {
    expect(parseAuthBackfillArguments([])).toEqual({ mode: 'check' });
    expect(
      parseAuthBackfillArguments([
        '--mode=apply',
        '--report-file=/tmp/auth-report.jsonl',
      ]),
    ).toEqual({
      mode: 'apply',
      reportFile: '/tmp/auth-report.jsonl',
    });
    for (const args of [
      ['--mode=invalid'],
      ['--unknown=value'],
      ['--report-file=relative.jsonl'],
      ['--mode=check', '--mode=apply'],
    ]) {
      expect(() => parseAuthBackfillArguments(args)).toThrow();
    }
    expect(
      authBackfillErrorCode(new AuthSchemaMigrationError('not ready')),
    ).toBe('MINETENANT_AUTH_SCHEMA_MIGRATION_UNSAFE');
    expect(authBackfillErrorCode(new Error('unexpected'))).toBe(
      'MINETENANT_AUTH_BACKFILL_UNEXPECTED',
    );

    const directory = await mkdtemp(join(tmpdir(), 'auth-backfill-report-'));
    try {
      const report = join(directory, 'report.jsonl');
      const violations: AuthBackfillViolation[] = [
        { userId: 'user-b', violationCode: 'PASSWORD_HASH_INVALID' },
        { userId: 'user-a', violationCode: 'USERNAME_INVALID' },
      ];
      await writeAuthBackfillReport(report, violations);
      expect((await stat(report)).mode & 0o777).toBe(0o600);
      expect(
        (await readFile(report, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { userId: 'user-a', violationCode: 'USERNAME_INVALID' },
        { userId: 'user-b', violationCode: 'PASSWORD_HASH_INVALID' },
      ]);
      await expect(
        writeAuthBackfillReport(report, violations),
      ).rejects.toMatchObject({ code: 'EEXIST' });

      const existing = join(directory, 'existing.jsonl');
      await writeFile(existing, 'keep\n', { mode: 0o600 });
      await expect(
        writeAuthBackfillReport(existing, violations),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(existing, 'utf8')).toBe('keep\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps CLI diagnostics free of user identifiers and secrets', async () => {
    await migrate(test.db);
    await insertLegacyUser(test.db, {
      userId: 'secret-user-id',
      email: 'secret@example.test',
      password: VALID_HASH.replace('$2b$', '$2a$'),
    });
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => messages.push(values.join(' '));
    try {
      await expect(
        executeAuthBackfill(test.db, { mode: 'check' }),
      ).rejects.toBeInstanceOf(AuthBackfillDataError);
    } finally {
      console.error = originalError;
    }
    const output = messages.join('\n');
    expect(output).not.toContain('secret-user-id');
    expect(output).not.toContain('secret@example.test');
    expect(output).not.toContain(VALID_HASH);
    expect(output).toContain('violationCounts=');
  });
});
