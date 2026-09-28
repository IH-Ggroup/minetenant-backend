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
import {
  createDatabase,
  type Database,
  type MigrationExecutor,
  type SqlExecutor,
} from '../src/db.js';
import {
  assertMigrationsCurrent,
  entityIdColumnsMigration,
  initialSchemaMigration,
  inspectMigrationStatus,
  migrations,
  runMigrations,
  type Migration,
} from '../src/db/migrations/index.js';
import { seedDemo } from '../scripts/seed.js';
import { createTestApp, type TestApp } from './helpers.js';

const TEST_DATABASE = 'minetenant_test';
const VALID_MIGRATION_HASH =
  '$2b$04$li0g2OT/y7U.0JQbXnC3euNhv2yFedgp/gBodO383UCSuOkZ3Var2';
const APPLICATION_TABLES = [
  'users',
  'stores',
  'products',
  'purchase_transactions',
  'product_status_migration_product_audit',
  'product_status_migration_request_audit',
  'hono_sessions',
  'hono_rate_limits',
] as const;
const ENTITY_ID_RENAMES = [
  { table: 'users', legacy: 'id', final: 'user_id' },
  { table: 'stores', legacy: 'id', final: 'store_id' },
  { table: 'stores', legacy: 'owner_id', final: 'user_id' },
  { table: 'products', legacy: 'id', final: 'product_id' },
  { table: 'products', legacy: 'seller_id', final: 'user_id' },
  {
    table: 'purchase_transactions',
    legacy: 'id',
    final: 'transaction_id',
  },
  {
    table: 'purchase_transactions',
    legacy: 'buyer_id',
    final: 'buyer_user_id',
  },
  {
    table: 'purchase_transactions',
    legacy: 'seller_id',
    final: 'seller_user_id',
  },
  { table: 'hono_sessions', legacy: 'id', final: 'session_id' },
] as const;
const TEST_TABLES = [
  'migration_test_entity_reference',
  'migration_test_exactly_once',
  'migration_test_first',
  'migration_test_partial',
  'migration_test_later',
  'migration_test_concurrent',
  'migration_test_known',
] as const;
const TEST_VIEWS = ['migration_test_entity_view'] as const;

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

async function dropViews(
  db: Database,
  views: readonly string[],
): Promise<void> {
  await assertTestDatabase(db);
  for (const view of views) {
    await db.execute(`DROP VIEW IF EXISTS \`${view}\``);
  }
}

async function dropAllTables(db: Database): Promise<void> {
  await dropViews(db, TEST_VIEWS);
  await dropTables(db, [
    ...TEST_TABLES,
    'product_status_migration_request_audit',
    'product_status_migration_product_audit',
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
    users: 'user_id',
    stores: 'store_id',
    products: 'product_id',
    purchase_transactions: 'transaction_id',
    product_status_migration_product_audit: 'product_id',
    product_status_migration_request_audit: 'transaction_id',
    hono_sessions: 'session_id',
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

async function prepareLegacySchema(
  db: Database,
  options: { populated?: boolean; keepHistory?: boolean } = {},
): Promise<void> {
  await dropAllTables(db);
  await runMigrations(db, [initialSchemaMigration]);
  if (options.populated) {
    const timestamp = '2026-09-25 00:00:00';
    await db.execute(
      `INSERT INTO users
        (id, name, email, password, role, role_label, avatar_initial, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?),
              (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'legacy-user',
        '移行対象ユーザー',
        'legacy@example.com',
        VALID_MIGRATION_HASH,
        'seller',
        '販売者',
        '移',
        timestamp,
        timestamp,
        'legacy-buyer',
        '移行対象購入者',
        'legacy-buyer@example.com',
        VALID_MIGRATION_HASH,
        'buyer',
        '購入者',
        '買',
        timestamp,
        timestamp,
      ],
    );
    await db.execute(
      `INSERT INTO stores
        (id, owner_id, name, description, level, points, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'legacy-store',
        'legacy-user',
        '移行対象店舗',
        '移行前のデータ',
        2,
        150,
        'connected',
        timestamp,
        timestamp,
      ],
    );
    await db.execute(
      `INSERT INTO products
        (id, store_id, seller_id, name, description, price, stock, category, theme, emoji, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'legacy-product',
        'legacy-store',
        'legacy-user',
        '移行対象商品',
        '移行前の商品データ',
        2500,
        1,
        'hobby',
        'forest',
        '📦',
        timestamp,
        timestamp,
      ],
    );
    await db.execute(
      `INSERT INTO purchase_transactions
        (id, request_id, product_id, buyer_id, seller_id, source, amount, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'legacy-transaction',
        'legacy-request',
        'legacy-product',
        'legacy-buyer',
        'legacy-user',
        'web',
        2500,
        'paid',
        timestamp,
        timestamp,
      ],
    );
    await db.execute(
      `INSERT INTO hono_sessions (id, user_id, csrf_token, expires_at)
       VALUES (?, ?, ?, ?)`,
      ['a'.repeat(64), 'legacy-user', 'b'.repeat(64), 9_999_999_999_999],
    );
  }
  if (options.keepHistory === false) {
    await dropTables(db, ['schema_migrations']);
  }
}

function oneDdlThenFail(db: Database): MigrationExecutor {
  let executed = false;
  return {
    query: db.query.bind(db),
    transaction: db.transaction.bind(db),
    async execute(sql, params) {
      if (executed) throw new Error('intentional restart after atomic DDL');
      executed = true;
      return db.execute(sql, params);
    },
  };
}

async function columnNames(db: Database, table: string): Promise<string[]> {
  const rows = await db.query<{ columnName: string }>(
    `SELECT COLUMN_NAME AS columnName
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ?
      ORDER BY ORDINAL_POSITION`,
    [table],
  );
  return rows.map(({ columnName }) => columnName);
}

async function renamedColumnDefinitions(
  db: Database,
  phase: 'legacy' | 'final',
) {
  return Promise.all(
    ENTITY_ID_RENAMES.map(async (definition) => {
      const column = definition[phase];
      const [row] = await db.query<{
        columnType: string;
        isNullable: string;
        characterSetName: string | null;
        collationName: string | null;
      }>(
        `SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
                CHARACTER_SET_NAME AS characterSetName,
                COLLATION_NAME AS collationName
           FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = ? AND column_name = ?`,
        [definition.table, column],
      );
      assert.ok(row, `${definition.table}.${column} must exist`);
      return {
        tableName: definition.table,
        columnName: definition.final,
        columnType: row.columnType,
        isNullable: row.isNullable,
        characterSetName: row.characterSetName,
        collationName: row.collationName,
      };
    }),
  );
}

async function renamedBusinessDataSnapshot(
  db: Database,
  phase: 'legacy' | 'final',
) {
  const userId = phase === 'legacy' ? 'id' : 'user_id';
  const storeId = phase === 'legacy' ? 'id' : 'store_id';
  const storeUserId = phase === 'legacy' ? 'owner_id' : 'user_id';
  const productId = phase === 'legacy' ? 'id' : 'product_id';
  const productUserId = phase === 'legacy' ? 'seller_id' : 'user_id';
  const transactionId = phase === 'legacy' ? 'id' : 'transaction_id';
  const buyerUserId = phase === 'legacy' ? 'buyer_id' : 'buyer_user_id';
  const sellerUserId = phase === 'legacy' ? 'seller_id' : 'seller_user_id';
  const sessionId = phase === 'legacy' ? 'id' : 'session_id';
  const [users, stores, products, transactions, sessions] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT ${userId} AS user_id, name, email, password, role, role_label,
              avatar_initial, created_at, updated_at
         FROM users ORDER BY ${userId}`,
    ),
    db.query<Record<string, unknown>>(
      `SELECT ${storeId} AS store_id, ${storeUserId} AS user_id, name,
              description, level, points, sync_status, created_at, updated_at
         FROM stores ORDER BY ${storeId}`,
    ),
    db.query<Record<string, unknown>>(
      `SELECT ${productId} AS product_id, store_id,
              ${productUserId} AS user_id, name, description, price, stock,
              category, theme, emoji, created_at, updated_at
         FROM products ORDER BY ${productId}`,
    ),
    db.query<Record<string, unknown>>(
      `SELECT ${transactionId} AS transaction_id, request_id, product_id,
              ${buyerUserId} AS buyer_user_id,
              ${sellerUserId} AS seller_user_id, source, amount, status,
              created_at, updated_at
         FROM purchase_transactions ORDER BY ${transactionId}`,
    ),
    db.query<Record<string, unknown>>(
      `SELECT ${sessionId} AS session_id, user_id, csrf_token, expires_at
         FROM hono_sessions ORDER BY ${sessionId}`,
    ),
  ]);
  return { users, stores, products, transactions, sessions };
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

  it('baselines and upgrades a populated legacy schema without changing IDs or relationships', async () => {
    await prepareLegacySchema(test.db, {
      populated: true,
      keepHistory: false,
    });
    const businessDataBefore = await renamedBusinessDataSnapshot(
      test.db,
      'legacy',
    );
    const columnDefinitionsBefore = await renamedColumnDefinitions(
      test.db,
      'legacy',
    );

    await migrate(test.db);

    expect(await renamedBusinessDataSnapshot(test.db, 'final')).toEqual({
      ...businessDataBefore,
      products: businessDataBefore.products.map((product) => ({
        ...product,
        stock: 0,
      })),
    });
    expect(await renamedColumnDefinitions(test.db, 'final')).toEqual(
      columnDefinitionsBefore,
    );
    expect(await appliedVersions(test.db)).toEqual(
      migrations.map(({ version }) => version),
    );
    expect(
      await test.db.query(
        `SELECT p.product_id, p.store_id, p.user_id,
                s.user_id AS store_user_id,
                t.transaction_id, t.buyer_user_id, t.seller_user_id
           FROM products AS p
           JOIN stores AS s ON s.store_id = p.store_id
           JOIN purchase_transactions AS t ON t.product_id = p.product_id`,
      ),
    ).toEqual([
      {
        product_id: 'legacy-product',
        store_id: 'legacy-store',
        user_id: 'legacy-user',
        store_user_id: 'legacy-user',
        transaction_id: 'legacy-transaction',
        buyer_user_id: 'legacy-buyer',
        seller_user_id: 'legacy-user',
      },
    ]);
    expect(
      await test.db.query('SELECT session_id, user_id FROM hono_sessions'),
    ).toEqual([{ session_id: 'a'.repeat(64), user_id: 'legacy-user' }]);
    expect(
      await test.db.query(
        "SELECT status, stock FROM products WHERE product_id = 'legacy-product'",
      ),
    ).toEqual([{ status: 'sold', stock: 0 }]);
  });

  it('upgrades Laravel-generated legacy index and foreign-key names', async () => {
    await prepareLegacySchema(test.db, { populated: true });
    await test.db.execute('ALTER TABLE stores DROP FOREIGN KEY stores_ibfk_1');
    await test.db.execute(`ALTER TABLE products
      DROP FOREIGN KEY products_ibfk_1,
      DROP FOREIGN KEY products_ibfk_2`);
    await test.db.execute(`ALTER TABLE purchase_transactions
      DROP FOREIGN KEY purchase_transactions_ibfk_1,
      DROP FOREIGN KEY purchase_transactions_ibfk_2,
      DROP FOREIGN KEY purchase_transactions_ibfk_3`);
    await test.db.execute(
      'ALTER TABLE users RENAME INDEX email TO users_email_unique',
    );
    await test.db.execute(
      'ALTER TABLE stores RENAME INDEX owner_id TO stores_owner_id_unique',
    );
    await test.db.execute(`ALTER TABLE stores
      ADD CONSTRAINT stores_owner_id_foreign
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT`);
    await test.db.execute(`ALTER TABLE products
      ADD CONSTRAINT products_store_id_foreign
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE RESTRICT,
      ADD CONSTRAINT products_seller_id_foreign
        FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE RESTRICT`);
    await test.db.execute(`ALTER TABLE purchase_transactions
      ADD CONSTRAINT purchase_transactions_product_id_foreign
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
      ADD CONSTRAINT purchase_transactions_buyer_id_foreign
        FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE RESTRICT,
      ADD CONSTRAINT purchase_transactions_seller_id_foreign
        FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE RESTRICT`);

    await expect(migrate(test.db)).resolves.toBeUndefined();
    expect(await appliedVersions(test.db)).toEqual(
      migrations.map(({ version }) => version),
    );
    expect(await renamedBusinessDataSnapshot(test.db, 'final')).toMatchObject({
      users: [{ user_id: 'legacy-buyer' }, { user_id: 'legacy-user' }],
      stores: [{ store_id: 'legacy-store', user_id: 'legacy-user' }],
      products: [{ product_id: 'legacy-product', user_id: 'legacy-user' }],
      transactions: [
        {
          transaction_id: 'legacy-transaction',
          buyer_user_id: 'legacy-buyer',
          seller_user_id: 'legacy-user',
        },
      ],
    });
  });

  it('resumes after every completed entity-ID DDL stage', async () => {
    await prepareLegacySchema(test.db, { populated: true });

    for (let stage = 1; stage < 13; stage += 1) {
      await expect(
        entityIdColumnsMigration.up(oneDdlThenFail(test.db)),
      ).rejects.toThrow('intentional restart after atomic DDL');
      await expect(
        entityIdColumnsMigration.preflight(test.db),
      ).resolves.toBeUndefined();
      expect(await appliedVersions(test.db)).toEqual([
        initialSchemaMigration.version,
      ]);
    }
    await expect(
      entityIdColumnsMigration.up(oneDdlThenFail(test.db)),
    ).resolves.toBeUndefined();
    await expect(
      entityIdColumnsMigration.verify(test.db),
    ).resolves.toBeUndefined();

    await migrate(test.db);
    expect(await appliedVersions(test.db)).toEqual(
      migrations.map(({ version }) => version),
    );
  });

  it('is a no-op after the entity-ID migration is recorded', async () => {
    const before = await applicationSnapshot(test.db);

    await migrate(test.db);
    await migrate(test.db);

    expect(await applicationSnapshot(test.db)).toEqual(before);
  });

  it('rejects legacy and final columns existing together before any DDL', async () => {
    await prepareLegacySchema(test.db);
    await test.db.execute(
      'ALTER TABLE users ADD COLUMN user_id VARCHAR(255) NULL',
    );
    const before = await columnNames(test.db, 'users');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'users')).toEqual(before);
    expect(await appliedVersions(test.db)).toEqual([
      initialSchemaMigration.version,
    ]);
  });

  it('rejects a rename pair with neither known column before any DDL', async () => {
    await prepareLegacySchema(test.db);
    await test.db.execute(
      'ALTER TABLE hono_sessions RENAME COLUMN id TO unexpected_session_id',
    );
    const before = await columnNames(test.db, 'hono_sessions');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'hono_sessions')).toEqual(before);
  });

  it('rejects an entity-ID type mismatch before any DDL', async () => {
    await prepareLegacySchema(test.db);
    await test.db.execute(`ALTER TABLE hono_sessions
      MODIFY COLUMN id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`);
    const before = await columnNames(test.db, 'users');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'users')).toEqual(before);
  });

  it('rejects orphan rows in a known partial state before the next DDL', async () => {
    await prepareLegacySchema(test.db);
    for (let stage = 1; stage <= 4; stage += 1) {
      await expect(
        entityIdColumnsMigration.up(oneDdlThenFail(test.db)),
      ).rejects.toThrow('intentional restart after atomic DDL');
    }
    await test.db.execute(
      `INSERT INTO hono_sessions (id, user_id, csrf_token, expires_at)
       VALUES (?, ?, ?, ?)`,
      ['c'.repeat(64), 'missing-user', 'd'.repeat(64), 9_999_999_999_999],
    );
    const before = await columnNames(test.db, 'users');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'users')).toEqual(before);
  });

  it('rejects duplicate store owners after the legacy unique index was dropped', async () => {
    await prepareLegacySchema(test.db, { populated: true });
    await expect(
      entityIdColumnsMigration.up(oneDdlThenFail(test.db)),
    ).rejects.toThrow('intentional restart after atomic DDL');
    await test.db.execute(
      `INSERT INTO stores
        (id, owner_id, name, description, level, points, sync_status)
       VALUES (?, ?, ?, '', 1, 0, 'offline')`,
      ['duplicate-store', 'legacy-user', '重複店舗'],
    );

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });
    expect(await appliedVersions(test.db)).toEqual([
      initialSchemaMigration.version,
    ]);
  });

  it('rejects a final index-name collision before any DDL', async () => {
    await prepareLegacySchema(test.db);
    await test.db.execute(
      'ALTER TABLE products ADD INDEX products_user_id_created_at_index (category)',
    );
    const before = await columnNames(test.db, 'stores');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'stores')).toEqual(before);
  });

  it('rejects a final foreign-key constraint-name collision before any DDL', async () => {
    await prepareLegacySchema(test.db);
    await test.db.execute(`CREATE TABLE migration_test_known (
      id INT PRIMARY KEY,
      legacy_user_id VARCHAR(255) NOT NULL,
      CONSTRAINT stores_user_id_foreign
        FOREIGN KEY (legacy_user_id) REFERENCES users(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const before = await columnNames(test.db, 'users');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'users')).toEqual(before);
    expect(await appliedVersions(test.db)).toEqual([
      initialSchemaMigration.version,
    ]);
  });

  it('rejects an unknown foreign key that references a renamed entity ID before any DDL', async () => {
    await prepareLegacySchema(test.db);
    await test.db.execute(`CREATE TABLE migration_test_entity_reference (
      id INT PRIMARY KEY,
      transaction_id VARCHAR(255) NOT NULL,
      CONSTRAINT migration_test_entity_reference_foreign
        FOREIGN KEY (transaction_id) REFERENCES purchase_transactions(id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const before = await columnNames(test.db, 'users');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'users')).toEqual(before);
    expect(await appliedVersions(test.db)).toEqual([
      initialSchemaMigration.version,
    ]);
  });

  it('rejects a view before a column rename can invalidate it', async () => {
    await prepareLegacySchema(test.db);
    await test.db.execute(`CREATE VIEW migration_test_entity_view AS
      SELECT id AS legacy_user_id, name FROM users`);
    const before = await columnNames(test.db, 'users');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'users')).toEqual(before);
    expect(await appliedVersions(test.db)).toEqual([
      initialSchemaMigration.version,
    ]);
  });

  it('rejects a missing preserved 0000 index before any DDL', async () => {
    await prepareLegacySchema(test.db);
    await test.db.execute(
      'ALTER TABLE products DROP INDEX products_category_index',
    );
    const before = await columnNames(test.db, 'users');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'users')).toEqual(before);
    expect(await appliedVersions(test.db)).toEqual([
      initialSchemaMigration.version,
    ]);
  });

  it('rejects a prefix variant of a preserved index before any DDL', async () => {
    await prepareLegacySchema(test.db);
    await test.db.execute(`ALTER TABLE products
      DROP INDEX products_category_index,
      ADD INDEX products_category_index (category(8))`);
    const before = await columnNames(test.db, 'users');

    await expect(migrate(test.db)).rejects.toMatchObject({
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });

    expect(await columnNames(test.db, 'users')).toEqual(before);
    expect(await appliedVersions(test.db)).toEqual([
      initialSchemaMigration.version,
    ]);
  });

  it('creates the exact final PK, index and foreign-key definitions', async () => {
    const indexes = await test.db.query<{
      tableName: string;
      indexName: string;
      nonUnique: number;
      columns: string;
    }>(
      `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
              NON_UNIQUE AS nonUnique,
              GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
         FROM information_schema.statistics
        WHERE table_schema = DATABASE()
        GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
    );
    const index = (tableName: string, indexName: string) =>
      indexes.find(
        (candidate) =>
          candidate.tableName === tableName &&
          candidate.indexName === indexName,
      );
    expect(index('users', 'PRIMARY')).toMatchObject({ columns: 'user_id' });
    expect(index('stores', 'PRIMARY')).toMatchObject({ columns: 'store_id' });
    expect(index('products', 'PRIMARY')).toMatchObject({
      columns: 'product_id',
    });
    expect(index('purchase_transactions', 'PRIMARY')).toMatchObject({
      columns: 'transaction_id',
    });
    expect(index('hono_sessions', 'PRIMARY')).toMatchObject({
      columns: 'session_id',
    });
    for (const [tableName, indexName, nonUnique, columns] of [
      ['users', 'email', 0, 'email'],
      ['users', 'users_role_index', 1, 'role'],
      ['stores', 'stores_sync_status_index', 1, 'sync_status'],
      ['products', 'products_category_index', 1, 'category'],
      ['products', 'products_created_at_index', 1, 'created_at'],
      [
        'products',
        'products_store_id_created_at_index',
        1,
        'store_id,created_at',
      ],
      [
        'purchase_transactions',
        'purchase_transactions_request_id_unique',
        0,
        'request_id',
      ],
      [
        'purchase_transactions',
        'purchase_transactions_source_index',
        1,
        'source',
      ],
      [
        'purchase_transactions',
        'purchase_transactions_status_index',
        1,
        'status',
      ],
      ['hono_sessions', 'hono_sessions_expiry', 1, 'expires_at'],
      ['hono_rate_limits', 'hono_rate_limits_expiry', 1, 'expires_at'],
    ] as const) {
      expect(index(tableName, indexName)).toMatchObject({
        nonUnique,
        columns,
      });
    }
    expect(index('stores', 'stores_user_id_unique')).toMatchObject({
      nonUnique: 0,
      columns: 'user_id',
    });
    expect(
      index('products', 'products_user_id_created_at_index'),
    ).toMatchObject({ nonUnique: 1, columns: 'user_id,created_at' });
    expect(
      index('products', 'products_user_id_listing_request_id_unique'),
    ).toMatchObject({
      nonUnique: 0,
      columns: 'user_id,listing_request_id',
    });
    expect(
      index('products', 'products_product_id_user_id_unique'),
    ).toMatchObject({ nonUnique: 0, columns: 'product_id,user_id' });
    expect(index('products', 'products_public_list_index')).toMatchObject({
      nonUnique: 1,
      columns: 'deleted_at,created_at',
    });
    expect(
      index('purchase_transactions', 'purchase_transactions_product_id_unique'),
    ).toMatchObject({ nonUnique: 0, columns: 'product_id' });
    expect(
      index('purchase_transactions', 'purchase_transactions_product_seller'),
    ).toMatchObject({ nonUnique: 1, columns: 'product_id,seller_user_id' });
    expect(
      index(
        'purchase_transactions',
        'purchase_transactions_buyer_user_id_created_at_index',
      ),
    ).toMatchObject({ nonUnique: 1, columns: 'buyer_user_id,created_at' });
    expect(
      index(
        'purchase_transactions',
        'purchase_transactions_seller_user_id_created_at_index',
      ),
    ).toMatchObject({ nonUnique: 1, columns: 'seller_user_id,created_at' });

    const foreignKeys = await test.db.query<{
      constraintName: string;
      tableName: string;
      columnName: string;
      referencedTableName: string;
      referencedColumnName: string;
      deleteRule: string;
    }>(
      `SELECT k.CONSTRAINT_NAME AS constraintName,
              k.TABLE_NAME AS tableName, k.COLUMN_NAME AS columnName,
              k.REFERENCED_TABLE_NAME AS referencedTableName,
              k.REFERENCED_COLUMN_NAME AS referencedColumnName,
              r.DELETE_RULE AS deleteRule
         FROM information_schema.key_column_usage AS k
         JOIN information_schema.referential_constraints AS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.TABLE_NAME = k.TABLE_NAME
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.CONSTRAINT_SCHEMA = DATABASE()
          AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    );
    expect(foreignKeys).toEqual([
      {
        constraintName: 'hono_sessions_user_id_foreign',
        tableName: 'hono_sessions',
        columnName: 'user_id',
        referencedTableName: 'users',
        referencedColumnName: 'user_id',
        deleteRule: 'CASCADE',
      },
      {
        constraintName: 'products_store_id_foreign',
        tableName: 'products',
        columnName: 'store_id',
        referencedTableName: 'stores',
        referencedColumnName: 'store_id',
        deleteRule: 'RESTRICT',
      },
      {
        constraintName: 'products_user_id_foreign',
        tableName: 'products',
        columnName: 'user_id',
        referencedTableName: 'users',
        referencedColumnName: 'user_id',
        deleteRule: 'RESTRICT',
      },
      {
        constraintName: 'purchase_transactions_buyer_user_id_foreign',
        tableName: 'purchase_transactions',
        columnName: 'buyer_user_id',
        referencedTableName: 'users',
        referencedColumnName: 'user_id',
        deleteRule: 'RESTRICT',
      },
      {
        constraintName: 'purchase_transactions_product_id_foreign',
        tableName: 'purchase_transactions',
        columnName: 'product_id',
        referencedTableName: 'products',
        referencedColumnName: 'product_id',
        deleteRule: 'RESTRICT',
      },
      {
        constraintName: 'purchase_transactions_product_seller_foreign',
        tableName: 'purchase_transactions',
        columnName: 'product_id',
        referencedTableName: 'products',
        referencedColumnName: 'product_id',
        deleteRule: 'RESTRICT',
      },
      {
        constraintName: 'purchase_transactions_product_seller_foreign',
        tableName: 'purchase_transactions',
        columnName: 'seller_user_id',
        referencedTableName: 'products',
        referencedColumnName: 'user_id',
        deleteRule: 'RESTRICT',
      },
      {
        constraintName: 'purchase_transactions_seller_user_id_foreign',
        tableName: 'purchase_transactions',
        columnName: 'seller_user_id',
        referencedTableName: 'users',
        referencedColumnName: 'user_id',
        deleteRule: 'RESTRICT',
      },
      {
        constraintName: 'stores_user_id_foreign',
        tableName: 'stores',
        columnName: 'user_id',
        referencedTableName: 'users',
        referencedColumnName: 'user_id',
        deleteRule: 'RESTRICT',
      },
    ]);
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
