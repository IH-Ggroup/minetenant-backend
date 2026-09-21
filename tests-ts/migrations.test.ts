import assert from 'node:assert/strict';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { migrate } from '../scripts/migrate.js';
import { createDatabase, type Database, type SqlExecutor } from '../src/db.js';
import {
  assertMigrationsCurrent,
  initialSchemaMigration,
  inspectMigrationStatus,
  migrations,
  runMigrations,
  type Migration,
} from '../src/db/migrations/index.js';
import { seedDemo } from '../scripts/seed.js';
import { createTestApp, type TestApp } from './helpers.js';

const TEST_DATABASE = 'minetenant_test';
const APPLICATION_TABLES = [
  'users',
  'stores',
  'products',
  'purchase_transactions',
  'hono_sessions',
  'hono_rate_limits',
] as const;
const TEST_TABLES = [
  'migration_test_exactly_once',
  'migration_test_first',
  'migration_test_partial',
  'migration_test_later',
  'migration_test_concurrent',
  'migration_test_known',
] as const;

async function assertTestDatabase(db: Database): Promise<void> {
  const [row] = await db.query<{ name: string | null }>(
    'SELECT DATABASE() AS name',
  );
  assert.equal(
    row?.name,
    TEST_DATABASE,
    'Migration tests may only mutate the dedicated test database.',
  );
}

async function dropTables(
  db: Database,
  tables: readonly string[],
): Promise<void> {
  await assertTestDatabase(db);
  for (const table of tables) {
    await db.execute(`DROP TABLE IF EXISTS \`${table}\``);
  }
}

async function dropAllTables(db: Database): Promise<void> {
  await dropTables(db, [
    ...TEST_TABLES,
    'purchase_transactions',
    'hono_sessions',
    'products',
    'stores',
    'hono_rate_limits',
    'users',
    'schema_migrations',
  ]);
}

async function restoreNormalDatabase(db: Database): Promise<void> {
  await dropAllTables(db);
  await migrate(db);
  await seedDemo(db, 4);
}

async function appliedVersions(db: Database): Promise<string[]> {
  const rows = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return rows.map(({ version }) => version);
}

async function tableExists(db: SqlExecutor, table: string): Promise<boolean> {
  const [row] = await db.query<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [table],
  );
  return row?.count === 1;
}

async function rowCount(db: SqlExecutor, table: string): Promise<number> {
  const [row] = await db.query<{ count: number }>(
    `SELECT COUNT(*) AS count FROM \`${table}\``,
  );
  return row?.count ?? 0;
}

async function expectRows(
  db: SqlExecutor,
  table: string,
  expected: number,
): Promise<void> {
  const actual = await rowCount(db, table);
  if (actual !== expected) {
    throw new Error(
      `Expected ${table} to contain ${expected} row(s), received ${actual}.`,
    );
  }
}

async function applicationSnapshot(db: Database) {
  const orderBy = {
    users: 'id',
    stores: 'id',
    products: 'id',
    purchase_transactions: 'id',
    hono_sessions: 'id',
    hono_rate_limits: 'key_hash',
  } satisfies Record<(typeof APPLICATION_TABLES)[number], string>;

  return Promise.all(
    APPLICATION_TABLES.map(async (table) => ({
      table,
      schema: await db.query(`SHOW CREATE TABLE \`${table}\``),
      rows: await db.query(
        `SELECT * FROM \`${table}\` ORDER BY \`${orderBy[table]}\``,
      ),
    })),
  );
}

describe('versioned MySQL migrations', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });

  beforeEach(async () => {
    await restoreNormalDatabase(test.db);
  });

  afterEach(async () => {
    await restoreNormalDatabase(test.db);
  });

  afterAll(async () => {
    if (!test) return;
    try {
      await restoreNormalDatabase(test.db);
    } finally {
      await test.close();
    }
  });

  it('creates the complete current schema and records its history on an empty database', async () => {
    await dropAllTables(test.db);
    expect(await inspectMigrationStatus(test.db, migrations)).toEqual({
      appliedVersions: [],
      pendingVersions: migrations.map(({ version }) => version),
    });
    await expect(
      assertMigrationsCurrent(test.db, migrations),
    ).rejects.toMatchObject({ code: 'MINETENANT_MIGRATION_PENDING' });

    await migrate(test.db);

    const rows = await test.db.query<{ name: string }>(
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
        ORDER BY table_name`,
    );
    expect(rows.map(({ name }) => name)).toEqual(
      [...APPLICATION_TABLES, 'schema_migrations'].toSorted(),
    );
    expect(await appliedVersions(test.db)).toEqual(
      migrations.map(({ version }) => version),
    );
    expect(await inspectMigrationStatus(test.db, migrations)).toEqual({
      appliedVersions: migrations.map(({ version }) => version),
      pendingVersions: [],
    });
    await expect(
      assertMigrationsCurrent(test.db, migrations),
    ).resolves.toMatchObject({ pendingVersions: [] });
  });

  it('rejects a history table that cannot enforce one row per version', async () => {
    await dropAllTables(test.db);
    await test.db.execute(`CREATE TABLE schema_migrations (
      version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB`);

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_MIGRATION_HISTORY_INVALID',
    });
    expect(await tableExists(test.db, 'users')).toBe(false);
  });

  it('stops before baseline changes when an existing legacy table is incompatible', async () => {
    await dropAllTables(test.db);
    await test.db.execute(`CREATE TABLE users (
      id VARCHAR(255) PRIMARY KEY
    ) ENGINE=InnoDB`);

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_SCHEMA_MISMATCH',
    });
    expect(await appliedVersions(test.db)).toEqual([]);
    expect(await tableExists(test.db, 'stores')).toBe(false);
  });

  it('baselines a populated legacy schema without changing its definitions or rows', async () => {
    const before = await applicationSnapshot(test.db);
    await dropTables(test.db, ['schema_migrations']);

    await migrate(test.db);

    expect(await applicationSnapshot(test.db)).toEqual(before);
    expect(await appliedVersions(test.db)).toEqual(
      migrations.map(({ version }) => version),
    );
    expect(await appliedVersions(test.db)).toContain(
      initialSchemaMigration.version,
    );
  });

  it('applies each version exactly once when the runner is invoked repeatedly', async () => {
    await dropTables(test.db, [
      'migration_test_exactly_once',
      'schema_migrations',
    ]);
    const migration: Migration = {
      version: '9000_test_exactly_once',
      preflight: async () => {},
      async up(db) {
        await db.execute(`CREATE TABLE migration_test_exactly_once (
          id INT PRIMARY KEY
        ) ENGINE=InnoDB`);
        await db.execute(
          'INSERT INTO migration_test_exactly_once (id) VALUES (1)',
        );
      },
      verify: (db) => expectRows(db, 'migration_test_exactly_once', 1),
    };

    await runMigrations(test.db, [migration]);
    await runMigrations(test.db, [migration]);

    expect(await rowCount(test.db, 'migration_test_exactly_once')).toBe(1);
    expect(await appliedVersions(test.db)).toEqual([migration.version]);
  });

  it('stops after a failed version and resumes that version before later work', async () => {
    await dropTables(test.db, [
      'migration_test_first',
      'migration_test_partial',
      'migration_test_later',
      'schema_migrations',
    ]);
    const first: Migration = {
      version: '9100_test_first',
      preflight: async () => {},
      async up(db) {
        await db.execute(`CREATE TABLE migration_test_first (
          id INT PRIMARY KEY
        ) ENGINE=InnoDB`);
        await db.execute('INSERT INTO migration_test_first (id) VALUES (1)');
      },
      verify: (db) => expectRows(db, 'migration_test_first', 1),
    };
    const failing: Migration = {
      version: '9101_test_failure',
      preflight: async () => {},
      async up(db) {
        await db.execute(`CREATE TABLE migration_test_partial (
          id INT PRIMARY KEY
        ) ENGINE=InnoDB`);
        await db.transaction(async (tx) => {
          await tx.execute(
            'INSERT INTO migration_test_partial (id) VALUES (1)',
          );
          throw new Error('intentional migration failure');
        });
      },
      verify: (db) => expectRows(db, 'migration_test_partial', 1),
    };
    const later: Migration = {
      version: '9102_test_later',
      preflight: async () => {},
      async up(db) {
        await db.execute(`CREATE TABLE migration_test_later (
          id INT PRIMARY KEY
        ) ENGINE=InnoDB`);
        await db.execute('INSERT INTO migration_test_later (id) VALUES (1)');
      },
      verify: (db) => expectRows(db, 'migration_test_later', 1),
    };

    await expect(
      runMigrations(test.db, [first, failing, later]),
    ).rejects.toThrow('intentional migration failure');
    expect(await appliedVersions(test.db)).toEqual([first.version]);
    expect(await tableExists(test.db, 'migration_test_partial')).toBe(true);
    expect(await rowCount(test.db, 'migration_test_partial')).toBe(0);
    expect(await tableExists(test.db, 'migration_test_later')).toBe(false);

    const repaired: Migration = {
      version: failing.version,
      preflight: async () => {},
      async up(db) {
        await db.execute(`CREATE TABLE IF NOT EXISTS migration_test_partial (
          id INT PRIMARY KEY
        ) ENGINE=InnoDB`);
        await db.execute(
          'INSERT IGNORE INTO migration_test_partial (id) VALUES (1)',
        );
      },
      verify: (db) => expectRows(db, 'migration_test_partial', 1),
    };
    await runMigrations(test.db, [first, repaired, later]);

    expect(await appliedVersions(test.db)).toEqual([
      first.version,
      repaired.version,
      later.version,
    ]);
    expect(await rowCount(test.db, 'migration_test_partial')).toBe(1);
    expect(await rowCount(test.db, 'migration_test_later')).toBe(1);
  });

  it('serializes concurrent runners from independent connection pools', async () => {
    await dropTables(test.db, [
      'migration_test_concurrent',
      'schema_migrations',
    ]);
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let executions = 0;
    const migration: Migration = {
      version: '9200_test_concurrent',
      preflight: async () => {},
      async up(db) {
        executions += 1;
        signalEntered();
        await db.execute(`CREATE TABLE migration_test_concurrent (
          id INT PRIMARY KEY
        ) ENGINE=InnoDB`);
        await db.query('SELECT SLEEP(0.2)');
        await db.execute(
          'INSERT INTO migration_test_concurrent (id) VALUES (1)',
        );
      },
      verify: (db) => expectRows(db, 'migration_test_concurrent', 1),
    };
    const firstDb = createDatabase(test.config);
    const secondDb = createDatabase(test.config);
    try {
      const firstRun = runMigrations(firstDb, [migration], {
        lockTimeoutSeconds: 5,
      });
      await Promise.race([
        entered,
        firstRun.then(() => {
          throw new Error('The first runner skipped the pending migration.');
        }),
      ]);
      const secondRun = runMigrations(secondDb, [migration], {
        lockTimeoutSeconds: 5,
      });
      await Promise.all([firstRun, secondRun]);
    } finally {
      await Promise.all([firstDb.close(), secondDb.close()]);
    }

    expect(executions).toBe(1);
    expect(await rowCount(test.db, 'migration_test_concurrent')).toBe(1);
    expect(await appliedVersions(test.db)).toEqual([migration.version]);
  });

  it('rejects migration history that is not a prefix of the known registry', async () => {
    await dropTables(test.db, ['migration_test_known', 'schema_migrations']);
    const migration: Migration = {
      version: '9300_test_known',
      preflight: async () => {},
      async up(db) {
        await db.execute(`CREATE TABLE migration_test_known (
          id INT PRIMARY KEY
        ) ENGINE=InnoDB`);
      },
      async verify(db) {
        if (!(await tableExists(db, 'migration_test_known'))) {
          throw new Error('Known migration table is missing.');
        }
      },
    };
    await runMigrations(test.db, [migration]);
    await test.db.execute(
      "INSERT INTO schema_migrations (version) VALUES ('9999_unknown')",
    );

    await expect(runMigrations(test.db, [migration])).rejects.toThrow(
      /history|prefix|unknown|version/i,
    );
    expect(await appliedVersions(test.db)).toEqual([
      migration.version,
      '9999_unknown',
    ]);
  });
});
