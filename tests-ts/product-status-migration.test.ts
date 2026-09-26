import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate.js';
import { seedDemo } from '../scripts/seed.js';
import { type Database, type MigrationExecutor } from '../src/db.js';
import { PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS } from '../src/db/product-status-audit-contract.js';
import {
  entityIdColumnsMigration,
  initialSchemaMigration,
  migrations,
  productStatusMigration,
  runMigrations,
} from '../src/db/migrations/index.js';
import { createTestApp, type TestApp } from './helpers.js';

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

async function assertTestDatabase(db: Database): Promise<void> {
  const [row] = await db.query<{ databaseName: string | null }>(
    'SELECT DATABASE() AS databaseName',
  );
  assert.equal(row?.databaseName, 'minetenant_test');
}

async function dropApplicationSchema(db: Database): Promise<void> {
  await assertTestDatabase(db);
  for (const table of APPLICATION_TABLES) {
    await db.execute(`DROP TABLE IF EXISTS \`${table}\``);
  }
}

async function prepareEntityIdSchema(db: Database): Promise<void> {
  await dropApplicationSchema(db);
  await runMigrations(db, [initialSchemaMigration, entityIdColumnsMigration]);
}

async function restoreCurrentSchema(db: Database): Promise<void> {
  await dropApplicationSchema(db);
  await migrate(db);
  await seedDemo(db, 4);
}

async function insertPrincipals(db: Database): Promise<void> {
  await db.execute(`INSERT INTO users
    (user_id, name, email, password, role, role_label, avatar_initial)
    VALUES
      ('migration-buyer', '移行購入者', 'migration-buyer@example.test', 'hash', 'buyer', '購入者', '買'),
      ('migration-seller', '移行販売者', 'migration-seller@example.test', 'hash', 'seller', '販売者', '販'),
      ('migration-other', '別の販売者', 'migration-other@example.test', 'hash', 'seller', '販売者', '別')`);
  await db.execute(`INSERT INTO stores
    (store_id, user_id, name, description, level, points, sync_status)
    VALUES ('migration-store', 'migration-seller', '移行店舗', '', 1, 0, 'connected')`);
}

async function insertLegacyProduct(
  db: Database,
  productId: string,
  stock: number,
  price: number,
): Promise<void> {
  await db.execute(
    `INSERT INTO products
      (product_id, store_id, user_id, name, description, price, stock,
       category, theme, emoji, created_at, updated_at)
     VALUES (?, 'migration-store', 'migration-seller', ?, '', ?, ?,
             'hobby', 'forest', '📦', '2026-09-01 00:00:00',
             '2026-09-01 00:00:00')`,
    [productId, productId, price, stock],
  );
}

async function insertTransaction(
  db: Database,
  transactionId: string,
  productId: string,
  requestId: string,
  amount: number,
  sellerId = 'migration-seller',
): Promise<void> {
  await db.execute(
    `INSERT INTO purchase_transactions
      (transaction_id, request_id, product_id, buyer_user_id, seller_user_id,
       source, amount, status, created_at, updated_at)
     VALUES (?, ?, ?, 'migration-buyer', ?, 'web', ?, 'paid',
             '2026-09-02 00:00:00', '2026-09-02 00:00:00')`,
    [transactionId, requestId, productId, sellerId, amount],
  );
}

async function addProductStatusColumns(db: Database): Promise<void> {
  await db.execute(`ALTER TABLE products
    ADD COLUMN status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL AFTER stock,
    ADD COLUMN listing_request_id VARCHAR(101) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL AFTER emoji,
    ADD COLUMN listing_request_fingerprint VARCHAR(65) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL AFTER listing_request_id,
    ADD COLUMN deleted_at TIMESTAMP(6) NULL DEFAULT NULL AFTER listing_request_fingerprint`);
}

async function addProductStatusAuditTables(db: Database): Promise<void> {
  for (const { createSql } of PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS) {
    await db.execute(createSql);
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

function failAfterBackfillDml(db: Database): MigrationExecutor {
  return {
    query: db.query.bind(db),
    execute: db.execute.bind(db),
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await fn(tx);
        throw new Error('intentional failure after backfill DML');
      }),
  };
}

function injectPopulatedProductBeforeBackfill(db: Database): MigrationExecutor {
  let inserted = false;
  return {
    query: db.query.bind(db),
    execute: db.execute.bind(db),
    async transaction(fn) {
      if (!inserted) {
        inserted = true;
        await db.execute(`INSERT INTO products
          (product_id, store_id, user_id, name, description, price, stock,
           status, category, theme, emoji)
          VALUES ('late-populated-product', 'migration-store',
                  'migration-seller', 'late product', '', 1000, 1,
                  'available', 'hobby', 'forest', '📦')`);
      }
      return db.transaction(fn);
    },
  };
}

function blockedTriggerCreation(
  db: Database,
  error: { code: string; errno: number },
): Database {
  return {
    query: db.query.bind(db),
    execute: db.execute.bind(db),
    transaction: db.transaction.bind(db),
    close: db.close.bind(db),
    withConnection: (fn) =>
      db.withConnection((connection, lease) =>
        fn(
          {
            query: connection.query.bind(connection),
            async execute(sql: string, params?: unknown[]) {
              if (/^CREATE TRIGGER/u.test(sql)) {
                throw Object.assign(
                  new Error('simulated CREATE TRIGGER failure'),
                  error,
                );
              }
              return connection.execute(sql, params);
            },
            transaction: connection.transaction.bind(connection),
          },
          lease,
        ),
      ),
  };
}

describe('0002 product status migration', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });

  beforeEach(async () => {
    await prepareEntityIdSchema(test.db);
  });

  afterAll(async () => {
    if (!test) return;
    try {
      await restoreCurrentSchema(test.db);
    } finally {
      await test.close();
    }
  });

  it('backfills transaction and stock combinations without changing business identity or history', async () => {
    await insertPrincipals(test.db);
    const fixtures = [
      ['tx-stock-0', 0, 1000, true, 'sold', 0],
      ['tx-stock-1', 1, 1100, true, 'sold', 0],
      ['tx-stock-2', 2, 1200, true, 'sold', 0],
      ['plain-stock-0', 0, 2000, false, 'sold', 0],
      ['plain-stock-1', 1, 2100, false, 'available', 1],
      ['plain-stock-2', 2, 2200, false, 'available', 1],
    ] as const;
    for (const [productId, stock, price, purchased] of fixtures) {
      await insertLegacyProduct(test.db, productId, stock, price);
      if (purchased) {
        await insertTransaction(
          test.db,
          `transaction-${productId}`,
          productId,
          `request-${productId}`,
          price,
        );
      }
    }
    const productsBefore = await test.db.query<{
      product_id: string;
      store_id: string;
      user_id: string;
      name: string;
      description: string;
      price: number;
      stock: number;
      category: string;
      theme: string;
      emoji: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT product_id, store_id, user_id, name, description, price, stock,
              category, theme, emoji, created_at, updated_at
         FROM products ORDER BY product_id`,
    );
    const transactionsBefore = await test.db.query<Record<string, unknown>>(
      `SELECT * FROM purchase_transactions ORDER BY transaction_id`,
    );

    await runMigrations(test.db, migrations);

    expect(
      await test.db.query(
        `SELECT product_id, original_stock, transaction_id,
                transaction_stock_anomaly
           FROM product_status_migration_product_audit
          ORDER BY product_id`,
      ),
    ).toEqual(
      fixtures
        .map(([productId, stock, , purchased]) => ({
          product_id: productId,
          original_stock: stock,
          transaction_id: purchased ? `transaction-${productId}` : null,
          transaction_stock_anomaly: purchased && stock > 0 ? 1 : 0,
        }))
        .toSorted((left, right) =>
          left.product_id.localeCompare(right.product_id),
        ),
    );
    expect(
      await test.db.query(
        'SELECT transaction_id FROM product_status_migration_request_audit',
      ),
    ).toEqual([]);
    expect(
      await test.db.query(
        `SELECT product_id, status, stock, listing_request_id,
                listing_request_fingerprint, deleted_at
           FROM products ORDER BY product_id`,
      ),
    ).toEqual(
      fixtures
        .map(([productId, , , , status, stock]) => ({
          product_id: productId,
          status,
          stock,
          listing_request_id: null,
          listing_request_fingerprint: null,
          deleted_at: null,
        }))
        .toSorted((left, right) =>
          left.product_id.localeCompare(right.product_id),
        ),
    );
    expect(
      await test.db.query(
        `SELECT product_id, store_id, user_id, name, description, price, stock,
                category, theme, emoji, created_at, updated_at
           FROM products ORDER BY product_id`,
      ),
    ).toEqual(
      productsBefore.map((product) => ({
        ...product,
        stock:
          fixtures.find(
            ([productId]) => productId === product.product_id,
          )?.[5] ?? product.stock,
      })),
    );
    expect(
      await test.db.query(
        `SELECT * FROM purchase_transactions ORDER BY transaction_id`,
      ),
    ).toEqual(transactionsBefore);
    expect(
      await test.db.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      ),
    ).toEqual(migrations.map(({ version }) => ({ version })));

    const currentSnapshot = await test.db.query(
      `SELECT product_id, price, stock, status, listing_request_id,
              listing_request_fingerprint, deleted_at
         FROM products ORDER BY product_id`,
    );
    await runMigrations(test.db, migrations);
    expect(
      await test.db.query(
        `SELECT product_id, price, stock, status, listing_request_id,
                listing_request_fingerprint, deleted_at
           FROM products ORDER BY product_id`,
      ),
    ).toEqual(currentSnapshot);
  });

  it('rejects unsafe legacy data before adding any product-status column', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'duplicate-history', 2, 1000);
    await insertTransaction(
      test.db,
      'duplicate-history-a',
      'duplicate-history',
      'duplicate-history-a',
      1000,
    );
    await insertTransaction(
      test.db,
      'duplicate-history-b',
      'duplicate-history',
      'duplicate-history-b',
      1000,
    );

    await expect(runMigrations(test.db, migrations)).rejects.toMatchObject({
      code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
    });
    expect(
      await test.db.query(
        `SELECT COLUMN_NAME AS columnName
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'products'
            AND column_name IN
                ('status', 'listing_request_id',
                 'listing_request_fingerprint', 'deleted_at')`,
      ),
    ).toEqual([]);
    expect(
      await test.db.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      ),
    ).toEqual([
      { version: initialSchemaMigration.version },
      { version: entityIdColumnsMigration.version },
    ]);
  });

  it.each([
    [
      'a seller mismatch',
      async () => {
        await insertLegacyProduct(test.db, 'seller-mismatch', 1, 1000);
        await insertTransaction(
          test.db,
          'seller-mismatch',
          'seller-mismatch',
          'seller-mismatch',
          1000,
          'migration-other',
        );
      },
    ],
    [
      'an invalid product price',
      async () => {
        await insertLegacyProduct(test.db, 'invalid-price', 1, 0);
      },
    ],
    [
      'an invalid product category',
      async () => {
        await insertLegacyProduct(test.db, 'invalid-category', 1, 1000);
        await test.db.execute(
          "UPDATE products SET category = 'unknown' WHERE product_id = 'invalid-category'",
        );
      },
    ],
    [
      'an invalid product theme',
      async () => {
        await insertLegacyProduct(test.db, 'invalid-theme', 1, 1000);
        await test.db.execute(
          "UPDATE products SET theme = 'unknown' WHERE product_id = 'invalid-theme'",
        );
      },
    ],
    [
      'a self-purchase transaction',
      async () => {
        await insertLegacyProduct(test.db, 'self-purchase', 1, 1000);
        await insertTransaction(
          test.db,
          'self-purchase',
          'self-purchase',
          'self-purchase',
          1000,
        );
        await test.db.execute(
          "UPDATE purchase_transactions SET buyer_user_id = seller_user_id WHERE transaction_id = 'self-purchase'",
        );
      },
    ],
    [
      'an invalid transaction source',
      async () => {
        await insertLegacyProduct(test.db, 'invalid-source', 1, 1000);
        await insertTransaction(
          test.db,
          'invalid-source',
          'invalid-source',
          'invalid-source',
          1000,
        );
        await test.db.execute(
          "UPDATE purchase_transactions SET source = 'legacy' WHERE transaction_id = 'invalid-source'",
        );
      },
    ],
    [
      'an invalid transaction status',
      async () => {
        await insertLegacyProduct(test.db, 'invalid-status', 1, 1000);
        await insertTransaction(
          test.db,
          'invalid-status',
          'invalid-status',
          'invalid-status',
          1000,
        );
        await test.db.execute(
          "UPDATE purchase_transactions SET status = 'unknown' WHERE transaction_id = 'invalid-status'",
        );
      },
    ],
    [
      'an invalid transaction amount',
      async () => {
        await insertLegacyProduct(test.db, 'invalid-amount', 1, 1000);
        await insertTransaction(
          test.db,
          'invalid-amount',
          'invalid-amount',
          'invalid-amount',
          1000,
        );
        await test.db.execute(
          "UPDATE purchase_transactions SET amount = 0 WHERE transaction_id = 'invalid-amount'",
        );
      },
    ],
    [
      'a same-name index collision',
      async () => {
        await test.db.execute(`ALTER TABLE products
          ADD INDEX products_public_list_index (category)`);
      },
    ],
    [
      'a missing #114 product-transaction index',
      async () => {
        await test.db.execute(`ALTER TABLE purchase_transactions
          ADD INDEX migration_test_product_fk_index (product_id)`);
        await test.db.execute(`ALTER TABLE purchase_transactions
          DROP INDEX purchase_transactions_product_id_index`);
      },
    ],
    [
      'a same-name foreign-key collision',
      async () => {
        await test.db.execute(`ALTER TABLE purchase_transactions
          ADD CONSTRAINT purchase_transactions_product_seller_foreign
          FOREIGN KEY (product_id) REFERENCES stores(store_id)
          ON DELETE RESTRICT ON UPDATE RESTRICT`);
      },
    ],
    [
      'a same-name check collision',
      async () => {
        await test.db.execute(`ALTER TABLE products
          ADD CONSTRAINT products_price_check CHECK (price >= 0)`);
      },
    ],
    [
      'a same-name trigger collision',
      async () => {
        await test.db
          .execute(`CREATE TRIGGER products_status_compatibility_before_insert
          BEFORE INSERT ON products FOR EACH ROW SET NEW.name = NEW.name`);
      },
    ],
  ] as const)(
    'rejects %s before starting 0002 DDL',
    async (_description, arrange) => {
      await insertPrincipals(test.db);
      await arrange();

      await expect(runMigrations(test.db, migrations)).rejects.toMatchObject({
        code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
      });
      expect(
        await test.db.query(
          `SELECT COLUMN_NAME AS columnName
             FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'products'
              AND column_name IN
                  ('status', 'listing_request_id',
                   'listing_request_fingerprint', 'deleted_at')`,
        ),
      ).toEqual([]);
      expect(
        await test.db.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = '0002_product_status'",
        ),
      ).toEqual([]);
    },
  );

  it('rejects a wrong same-name product column without changing its partial state', async () => {
    await insertPrincipals(test.db);
    await test.db.execute('ALTER TABLE products ADD COLUMN status INT NULL');
    const before = await test.db.query(
      `SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'products'
          AND column_name IN
              ('status', 'listing_request_id',
               'listing_request_fingerprint', 'deleted_at')
        ORDER BY ORDINAL_POSITION`,
    );

    await expect(runMigrations(test.db, migrations)).rejects.toMatchObject({
      code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
    });
    expect(
      await test.db.query(
        `SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'products'
            AND column_name IN
                ('status', 'listing_request_id',
                 'listing_request_fingerprint', 'deleted_at')
          ORDER BY ORDINAL_POSITION`,
      ),
    ).toEqual(before);
    expect(
      await test.db.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = '0002_product_status'",
      ),
    ).toEqual([]);
  });

  it('rejects an audit table that could cascade away retained history', async () => {
    await test.db.execute(`CREATE TABLE product_status_migration_product_audit (
      product_id VARCHAR(255) NOT NULL,
      original_stock INT UNSIGNED NOT NULL,
      transaction_id VARCHAR(255) NULL,
      transaction_stock_anomaly TINYINT UNSIGNED NOT NULL,
      captured_at TIMESTAMP(6) NOT NULL,
      PRIMARY KEY (product_id),
      CONSTRAINT product_status_audit_product_cascade
        FOREIGN KEY (product_id) REFERENCES products(product_id)
        ON DELETE CASCADE ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await expect(runMigrations(test.db, migrations)).rejects.toMatchObject({
      code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
      message: expect.stringMatching(/unexpected foreign key on audit table/i),
    });
    expect(
      await test.db.query(
        `SELECT COLUMN_NAME AS columnName
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'products'
            AND column_name IN
                ('status', 'listing_request_id',
                 'listing_request_fingerprint', 'deleted_at')`,
      ),
    ).toEqual([]);
    expect(
      await test.db.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = '0002_product_status'",
      ),
    ).toEqual([]);
  });

  it('rejects a same-token CHECK whose logical grouping is different', async () => {
    await insertPrincipals(test.db);
    await addProductStatusColumns(test.db);
    await test.db.execute(`ALTER TABLE products
      ADD CONSTRAINT products_listing_request_pair_check CHECK (
        listing_request_id IS NULL
        AND (listing_request_fingerprint IS NULL
             OR listing_request_id IS NOT NULL)
        AND listing_request_fingerprint IS NOT NULL
      )`);

    await expect(runMigrations(test.db, migrations)).rejects.toMatchObject({
      code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
      message: expect.stringMatching(/check constraint name collision/i),
    });
    expect(
      await test.db.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = '0002_product_status'",
      ),
    ).toEqual([]);
    expect(
      await test.db.query(
        `SELECT TABLE_NAME AS tableName FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name LIKE 'product_status_migration_%_audit'`,
      ),
    ).toEqual([]);
  });

  it.each(["'AVAILABLE', 'sold'", "'avail able', 'sold'"])(
    'rejects a same-name status CHECK with changed literal values: %s',
    async (values) => {
      await insertPrincipals(test.db);
      await addProductStatusColumns(test.db);
      await test.db.execute(`ALTER TABLE products
        ADD CONSTRAINT products_status_check
        CHECK (BINARY status IN (${values}))`);

      await expect(runMigrations(test.db, migrations)).rejects.toMatchObject({
        code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
        message: expect.stringMatching(/check constraint name collision/i),
      });
      expect(
        await test.db.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = '0002_product_status'",
        ),
      ).toEqual([]);
    },
  );

  it.each([
    {
      mysqlError: { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 },
      message: /TRIGGER privilege/u,
    },
    {
      mysqlError: {
        code: 'ER_BINLOG_CREATE_ROUTINE_NEED_SUPER',
        errno: 1419,
      },
      message: /log_bin_trust_function_creators/u,
    },
  ])(
    'reports the actual CREATE TRIGGER failure and remains resumable: $mysqlError.code',
    async ({ mysqlError, message }) => {
      await insertPrincipals(test.db);

      await expect(
        runMigrations(blockedTriggerCreation(test.db, mysqlError), migrations),
      ).rejects.toMatchObject({
        code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
        message: expect.stringMatching(message),
        cause: expect.objectContaining(mysqlError),
      });
      expect(
        await test.db.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = '0002_product_status'",
        ),
      ).toEqual([]);

      await expect(runMigrations(test.db, migrations)).resolves.toEqual({
        appliedVersions: ['0002_product_status'],
      });
      await expect(productStatusMigration.verify(test.db)).resolves.toBe(
        undefined,
      );
    },
  );

  it('accepts status columns without audit tables when products is empty', async () => {
    await addProductStatusColumns(test.db);

    await expect(productStatusMigration.preflight(test.db)).resolves.toBe(
      undefined,
    );
    expect(
      await test.db.query(
        `SELECT TABLE_NAME AS tableName FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name LIKE 'product_status_migration_%_audit'`,
      ),
    ).toEqual([]);
  });

  it('does not invent original stock for a populated product added after preflight', async () => {
    await insertPrincipals(test.db);
    await addProductStatusColumns(test.db);
    await productStatusMigration.preflight(test.db);

    await expect(
      productStatusMigration.up(injectPopulatedProductBeforeBackfill(test.db)),
    ).rejects.toMatchObject({
      code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
      message: expect.stringMatching(
        /product stock migration audit is missing or inconsistent/i,
      ),
    });
    expect(
      await test.db.query(
        `SELECT product_id, original_stock
           FROM product_status_migration_product_audit`,
      ),
    ).toEqual([]);
  });

  it('accepts the normal partial state where every product status is still NULL', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'all-null-resume', 2, 1000);
    await addProductStatusColumns(test.db);

    await expect(productStatusMigration.preflight(test.db)).resolves.toBe(
      undefined,
    );
    expect(
      await test.db.query(
        `SELECT product_id, stock, status FROM products
          WHERE product_id = 'all-null-resume'`,
      ),
    ).toEqual([{ product_id: 'all-null-resume', stock: 2, status: null }]);
  });

  it('rejects populated statuses when the persistent audit tables are missing', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'populated-without-audit', 2, 1000);
    await addProductStatusColumns(test.db);
    await test.db.execute(`UPDATE products
      SET status = 'available', stock = 1
      WHERE product_id = 'populated-without-audit'`);

    await expect(
      productStatusMigration.preflight(test.db),
    ).rejects.toMatchObject({
      code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
      message: expect.stringMatching(
        /requires both complete migration audit tables/i,
      ),
    });
    expect(
      await test.db.query(
        `SELECT TABLE_NAME AS tableName FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name LIKE 'product_status_migration_%_audit'`,
      ),
    ).toEqual([]);
  });

  it('rejects populated statuses when audit row coverage is incomplete', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'populated-without-row', 2, 1000);
    await addProductStatusColumns(test.db);
    await addProductStatusAuditTables(test.db);
    await test.db.execute(`UPDATE products
      SET status = 'available', stock = 1
      WHERE product_id = 'populated-without-row'`);

    await expect(
      productStatusMigration.preflight(test.db),
    ).rejects.toMatchObject({
      code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
      message: expect.stringMatching(
        /product stock migration audit is missing or inconsistent/i,
      ),
    });
  });

  it('rejects a populated status/stock pair that disagrees with the original-stock audit', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'populated-wrong-state', 2, 1000);
    await addProductStatusColumns(test.db);
    await addProductStatusAuditTables(test.db);
    await test.db.execute(`UPDATE products
      SET status = 'sold', stock = 0
      WHERE product_id = 'populated-wrong-state'`);
    await test.db.execute(`INSERT INTO product_status_migration_product_audit
      (product_id, original_stock, transaction_id,
       transaction_stock_anomaly, captured_at)
      VALUES ('populated-wrong-state', 2, NULL, 0, UTC_TIMESTAMP(6))`);

    await expect(
      productStatusMigration.preflight(test.db),
    ).rejects.toMatchObject({
      code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
      message: expect.stringMatching(
        /product stock migration audit is missing or inconsistent/i,
      ),
    });
  });

  it('resumes a fully populated state only when its complete audit is consistent', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'resume-audited-available', 2, 1000);
    await insertLegacyProduct(test.db, 'resume-audited-sold', 3, 1100);
    await insertTransaction(
      test.db,
      'resume-audited-transaction',
      'resume-audited-sold',
      'resume-audited-request',
      1100,
    );
    await addProductStatusColumns(test.db);
    await addProductStatusAuditTables(test.db);
    await test.db.execute(`UPDATE products
      SET status = 'available', stock = 1
      WHERE product_id = 'resume-audited-available'`);
    await test.db.execute(`UPDATE products
      SET status = 'sold', stock = 0
      WHERE product_id = 'resume-audited-sold'`);
    await test.db.execute(`INSERT INTO product_status_migration_product_audit
      (product_id, original_stock, transaction_id,
       transaction_stock_anomaly, captured_at)
      VALUES
        ('resume-audited-available', 2, NULL, 0, UTC_TIMESTAMP(6)),
        ('resume-audited-sold', 3, 'resume-audited-transaction', 1,
         UTC_TIMESTAMP(6))`);

    await runMigrations(test.db, migrations);

    expect(
      await test.db.query(
        `SELECT p.product_id, p.status, p.stock, a.original_stock,
                a.transaction_id
           FROM products p
           JOIN product_status_migration_product_audit a
             ON a.product_id = p.product_id
          ORDER BY p.product_id`,
      ),
    ).toEqual([
      {
        product_id: 'resume-audited-available',
        status: 'available',
        stock: 1,
        original_stock: 2,
        transaction_id: null,
      },
      {
        product_id: 'resume-audited-sold',
        status: 'sold',
        stock: 0,
        original_stock: 3,
        transaction_id: 'resume-audited-transaction',
      },
    ]);
  });

  it('rolls the entire data back when the status backfill fails and permits a clean retry', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'backfill-first', 2, 1000);
    await insertLegacyProduct(test.db, 'backfill-failure', 0, 1100);
    await productStatusMigration.preflight(test.db);
    await expect(
      productStatusMigration.up(failAfterBackfillDml(test.db)),
    ).rejects.toThrow('intentional failure after backfill DML');
    expect(
      await test.db.query(
        `SELECT product_id, stock, status FROM products ORDER BY product_id`,
      ),
    ).toEqual([
      { product_id: 'backfill-failure', stock: 0, status: null },
      { product_id: 'backfill-first', stock: 2, status: null },
    ]);
    expect(
      await test.db.query(
        'SELECT product_id FROM product_status_migration_product_audit',
      ),
    ).toEqual([]);
    expect(
      await test.db.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = '0002_product_status'",
      ),
    ).toEqual([]);

    await runMigrations(test.db, migrations);
    expect(
      await test.db.query(
        `SELECT product_id, stock, status FROM products ORDER BY product_id`,
      ),
    ).toEqual([
      { product_id: 'backfill-failure', stock: 0, status: 'sold' },
      { product_id: 'backfill-first', stock: 1, status: 'available' },
    ]);
  });

  it('preserves grandfathered request IDs while changing to binary NO PAD collation', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'legacy-request-product', 1, 1000);
    await insertLegacyProduct(test.db, 'legacy-request-line-feed', 1, 1001);
    await insertLegacyProduct(
      test.db,
      'legacy-request-carriage-return',
      1,
      1002,
    );
    await insertLegacyProduct(test.db, 'legacy-request-empty', 1, 1003);
    await insertLegacyProduct(test.db, 'legacy-request-long-allowed', 1, 1004);
    const legacyRequestId = `Legacy request 日本語 ${'x'.repeat(110)} `;
    const lineFeedRequestId = 'legacy-line-feed\n';
    const carriageReturnRequestId = 'legacy-carriage-return\r';
    const emptyRequestId = '';
    const longAllowedRequestId = 'a'.repeat(101);
    await insertTransaction(
      test.db,
      'legacy-request-transaction',
      'legacy-request-product',
      legacyRequestId,
      1000,
    );
    await insertTransaction(
      test.db,
      'legacy-request-line-feed-transaction',
      'legacy-request-line-feed',
      lineFeedRequestId,
      1001,
    );
    await insertTransaction(
      test.db,
      'legacy-request-carriage-return-transaction',
      'legacy-request-carriage-return',
      carriageReturnRequestId,
      1002,
    );
    await insertTransaction(
      test.db,
      'legacy-request-empty-transaction',
      'legacy-request-empty',
      emptyRequestId,
      1003,
    );
    await insertTransaction(
      test.db,
      'legacy-request-long-allowed-transaction',
      'legacy-request-long-allowed',
      longAllowedRequestId,
      1004,
    );

    await runMigrations(test.db, migrations);

    expect(
      await test.db.query<{ request_id: string }>(
        `SELECT request_id FROM purchase_transactions
          ORDER BY transaction_id`,
      ),
    ).toEqual([
      { request_id: carriageReturnRequestId },
      { request_id: emptyRequestId },
      { request_id: lineFeedRequestId },
      { request_id: longAllowedRequestId },
      { request_id: legacyRequestId },
    ]);
    expect(
      await test.db.query(
        `SELECT transaction_id, request_id_sha256,
                request_id_character_length, violates_current_length_limit,
                contains_noncanonical_character
           FROM product_status_migration_request_audit
          ORDER BY transaction_id`,
      ),
    ).toEqual([
      {
        transaction_id: 'legacy-request-carriage-return-transaction',
        request_id_sha256: createHash('sha256')
          .update(carriageReturnRequestId, 'utf8')
          .digest('hex'),
        request_id_character_length: [...carriageReturnRequestId].length,
        violates_current_length_limit: 0,
        contains_noncanonical_character: 1,
      },
      {
        transaction_id: 'legacy-request-empty-transaction',
        request_id_sha256: createHash('sha256')
          .update(emptyRequestId, 'utf8')
          .digest('hex'),
        request_id_character_length: 0,
        violates_current_length_limit: 1,
        contains_noncanonical_character: 0,
      },
      {
        transaction_id: 'legacy-request-line-feed-transaction',
        request_id_sha256: createHash('sha256')
          .update(lineFeedRequestId, 'utf8')
          .digest('hex'),
        request_id_character_length: [...lineFeedRequestId].length,
        violates_current_length_limit: 0,
        contains_noncanonical_character: 1,
      },
      {
        transaction_id: 'legacy-request-long-allowed-transaction',
        request_id_sha256: createHash('sha256')
          .update(longAllowedRequestId, 'utf8')
          .digest('hex'),
        request_id_character_length: 101,
        violates_current_length_limit: 1,
        contains_noncanonical_character: 0,
      },
      {
        transaction_id: 'legacy-request-transaction',
        request_id_sha256: createHash('sha256')
          .update(legacyRequestId, 'utf8')
          .digest('hex'),
        request_id_character_length: [...legacyRequestId].length,
        violates_current_length_limit: 1,
        contains_noncanonical_character: 1,
      },
    ]);
  });

  it('resumes every known partial DDL state before recording migration history', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'restart-product', 2, 2500);

    let completed = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await productStatusMigration.preflight(test.db);
      try {
        await productStatusMigration.up(oneDdlThenFail(test.db));
        completed = true;
        break;
      } catch (error) {
        const failure = error as { message?: string; cause?: unknown };
        const cause = failure.cause as { message?: string } | undefined;
        expect([failure.message, cause?.message]).toContain(
          'intentional restart after atomic DDL',
        );
      }
    }
    expect(completed).toBe(true);
    await productStatusMigration.verify(test.db);
    expect(
      await test.db.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      ),
    ).toEqual([
      { version: initialSchemaMigration.version },
      { version: entityIdColumnsMigration.version },
    ]);

    await runMigrations(test.db, migrations);
    expect(
      await test.db.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      ),
    ).toEqual(migrations.map(({ version }) => ({ version })));
  }, 120_000);

  it('keeps legacy writers compatible while enforcing one-way status transitions', async () => {
    await insertPrincipals(test.db);
    await runMigrations(test.db, migrations);

    await insertLegacyProduct(test.db, 'legacy-many', 8, 3000);
    await insertLegacyProduct(test.db, 'legacy-zero', 0, 3100);
    expect(
      await test.db.query(
        `SELECT product_id, status, stock FROM products
          WHERE product_id LIKE 'legacy-%' ORDER BY product_id`,
      ),
    ).toEqual([
      { product_id: 'legacy-many', status: 'available', stock: 1 },
      { product_id: 'legacy-zero', status: 'sold', stock: 0 },
    ]);

    await test.db.execute(
      "UPDATE products SET stock = 9 WHERE product_id = 'legacy-many'",
    );
    expect(
      await test.db.query(
        "SELECT status, stock FROM products WHERE product_id = 'legacy-many'",
      ),
    ).toEqual([{ status: 'available', stock: 1 }]);
    await test.db.execute(
      "UPDATE products SET stock = 0 WHERE product_id = 'legacy-many'",
    );
    expect(
      await test.db.query(
        "SELECT status, stock FROM products WHERE product_id = 'legacy-many'",
      ),
    ).toEqual([{ status: 'sold', stock: 0 }]);
    await expect(
      test.db.execute(
        "UPDATE products SET stock = 1 WHERE product_id = 'legacy-many'",
      ),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });

    await expect(
      test.db.execute(`INSERT INTO products
        (product_id, store_id, user_id, name, description, price, stock,
         status, category, theme, emoji)
        VALUES ('invalid-pair', 'migration-store', 'migration-seller',
                'invalid', '', 1000, 0, 'available', 'hobby', 'forest', '📦')`),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
    await expect(
      test.db.execute(`INSERT INTO products
        (product_id, store_id, user_id, name, description, price, stock,
         category, theme, emoji)
        VALUES ('null-stock', 'migration-store', 'migration-seller',
                'null stock', '', 1000, NULL,
                'hobby', 'forest', '📦')`),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
    await test.db.execute(`INSERT INTO products
      (product_id, store_id, user_id, name, description, price, stock,
       status, category, theme, emoji)
      VALUES ('new-writer-sold', 'migration-store', 'migration-seller',
              'sold', '', 1000, 0, 'sold', 'hobby', 'forest', '📦')`);
    await test.db.execute(`INSERT INTO products
      (product_id, store_id, user_id, name, description, price, stock,
       status, category, theme, emoji)
      VALUES ('new-writer-available', 'migration-store', 'migration-seller',
              'available', '', 1000, 1, 'available',
              'hobby', 'forest', '📦')`);
    await test.db.execute(`UPDATE products
      SET status = 'sold', stock = 0
      WHERE product_id = 'new-writer-available'`);
    expect(
      await test.db.query(
        `SELECT status, stock FROM products
          WHERE product_id = 'new-writer-available'`,
      ),
    ).toEqual([{ status: 'sold', stock: 0 }]);
    await expect(
      test.db.execute(`UPDATE products
        SET status = 'available', stock = 1
        WHERE product_id = 'new-writer-sold'`),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
  });

  it('protects listing tombstones while legacy rows remain physically deletable', async () => {
    await insertPrincipals(test.db);
    await runMigrations(test.db, migrations);
    await insertLegacyProduct(test.db, 'legacy-delete', 1, 1000);
    await test.db.execute(
      `INSERT INTO products
      (product_id, store_id, user_id, name, description, price, stock, status,
       listing_request_id, listing_request_fingerprint,
       category, theme, emoji)
      VALUES ('listing-tombstone', 'migration-store', 'migration-seller',
              'tombstone', '', 1000, 1, 'available', 'listing-request',
              ?, 'hobby', 'forest', '📦')`,
      ['a'.repeat(64)],
    );

    await expect(
      test.db.execute(
        "DELETE FROM products WHERE product_id = 'listing-tombstone'",
      ),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
    await expect(
      test.db.execute(
        "DELETE FROM products WHERE product_id = 'legacy-delete'",
      ),
    ).resolves.toMatchObject({ affectedRows: 1 });
    expect(
      await test.db.query(
        "SELECT product_id FROM products WHERE product_id = 'listing-tombstone'",
      ),
    ).toEqual([{ product_id: 'listing-tombstone' }]);
  });

  it('keeps request audit and listing checks independent of NO_BACKSLASH_ESCAPES', async () => {
    await insertPrincipals(test.db);
    await insertLegacyProduct(test.db, 'sql-mode-product', 1, 1000);
    await insertTransaction(
      test.db,
      'sql-mode-transaction',
      'sql-mode-product',
      'canonical-request-id',
      1000,
    );

    await test.db.withConnection(async (db, lease) => {
      // This mode is connection-scoped. Destroy the lease afterward so it
      // cannot affect another test if this assertion fails midway.
      lease.discard();
      await db.execute("SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'");
      await productStatusMigration.preflight(db);
      await productStatusMigration.up(db);
      await productStatusMigration.verify(db);

      expect(
        await db.query(
          'SELECT transaction_id FROM product_status_migration_request_audit',
        ),
      ).toEqual([]);

      const insertListing = (
        productId: string,
        requestId: string,
        fingerprint: string,
      ) =>
        db.execute(
          `INSERT INTO products
            (product_id, store_id, user_id, name, description, price, stock,
             status, listing_request_id, listing_request_fingerprint,
             category, theme, emoji)
           VALUES (?, 'migration-store', 'migration-seller', ?, '', 1000, 1,
                   'available', ?, ?, 'hobby', 'forest', '📦')`,
          [productId, productId, requestId, fingerprint],
        );
      await expect(
        insertListing(
          'sql-mode-valid-listing',
          'r'.repeat(100),
          'a'.repeat(64),
        ),
      ).resolves.toMatchObject({ affectedRows: 1 });
      await expect(
        insertListing('sql-mode-long-request', 'r'.repeat(101), 'a'.repeat(64)),
      ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
      await expect(
        insertListing(
          'sql-mode-long-fingerprint',
          'another-request',
          'a'.repeat(65),
        ),
      ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
      await expect(
        insertListing(
          'sql-mode-uppercase-fingerprint',
          'uppercase-fingerprint',
          'A'.repeat(64),
        ),
      ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    });
  });

  it('creates exact columns, collations, indexes, checks and seller-consistency FK', async () => {
    await insertPrincipals(test.db);
    await runMigrations(test.db, migrations);

    const columns = await test.db.query<{
      columnName: string;
      columnType: string;
      isNullable: string;
      characterSetName: string | null;
      collationName: string | null;
    }>(`SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
               IS_NULLABLE AS isNullable,
               CHARACTER_SET_NAME AS characterSetName,
               COLLATION_NAME AS collationName
          FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND ((table_name = 'products' AND column_name IN
                 ('status', 'listing_request_id',
                  'listing_request_fingerprint', 'deleted_at'))
             OR (table_name = 'purchase_transactions'
                 AND column_name = 'request_id'))
         ORDER BY table_name, ORDINAL_POSITION`);
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columnName: 'status',
          columnType: 'varchar(16)',
          isNullable: 'YES',
          characterSetName: 'ascii',
          collationName: 'ascii_bin',
        }),
        expect.objectContaining({
          columnName: 'listing_request_id',
          columnType: 'varchar(101)',
          isNullable: 'YES',
          characterSetName: 'ascii',
          collationName: 'ascii_bin',
        }),
        expect.objectContaining({
          columnName: 'listing_request_fingerprint',
          columnType: 'varchar(65)',
          isNullable: 'YES',
          characterSetName: 'ascii',
          collationName: 'ascii_bin',
        }),
        expect.objectContaining({
          columnName: 'deleted_at',
          columnType: 'timestamp(6)',
          isNullable: 'YES',
        }),
        expect.objectContaining({
          columnName: 'request_id',
          columnType: 'varchar(255)',
          characterSetName: 'utf8mb4',
          collationName: 'utf8mb4_0900_bin',
        }),
      ]),
    );

    const indexes = await test.db.query<{
      tableName: string;
      indexName: string;
      nonUnique: number;
      columns: string;
    }>(`SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
               NON_UNIQUE AS nonUnique,
               GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
          FROM information_schema.statistics
         WHERE table_schema = DATABASE()
         GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`);
    const index = (name: string) =>
      indexes.find(({ indexName }) => indexName === name);
    expect(index('products_user_id_listing_request_id_unique')).toMatchObject({
      tableName: 'products',
      nonUnique: 0,
      columns: 'user_id,listing_request_id',
    });
    expect(index('products_product_id_user_id_unique')).toMatchObject({
      tableName: 'products',
      nonUnique: 0,
      columns: 'product_id,user_id',
    });
    expect(index('products_public_list_index')).toMatchObject({
      tableName: 'products',
      nonUnique: 1,
      columns: 'deleted_at,created_at',
    });
    expect(index('purchase_transactions_product_id_unique')).toMatchObject({
      tableName: 'purchase_transactions',
      nonUnique: 0,
      columns: 'product_id',
    });
    expect(index('purchase_transactions_product_seller')).toMatchObject({
      tableName: 'purchase_transactions',
      nonUnique: 1,
      columns: 'product_id,seller_user_id',
    });

    const checks = await test.db.query<{
      constraintName: string;
      checkClause: string;
      enforced: string;
    }>(
      `SELECT tc.CONSTRAINT_NAME AS constraintName,
              cc.CHECK_CLAUSE AS checkClause, tc.ENFORCED AS enforced
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.check_constraints AS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.constraint_schema = DATABASE()
          AND tc.constraint_type = 'CHECK'`,
    );
    expect(
      checks.map(({ constraintName }) => constraintName).toSorted(),
    ).toEqual(
      [
        'products_category_check',
        'products_deleted_status_check',
        'products_listing_request_fingerprint_check',
        'products_listing_request_id_check',
        'products_listing_request_pair_check',
        'products_price_check',
        'products_status_check',
        'products_theme_check',
        'purchase_transactions_amount_check',
        'purchase_transactions_distinct_users_check',
        'purchase_transactions_source_check',
        'purchase_transactions_status_check',
      ].toSorted(),
    );
    expect(checks.every(({ enforced }) => enforced === 'YES')).toBe(true);
    expect(
      checks.every(({ checkClause }) => checkClause.trim().length > 0),
    ).toBe(true);

    expect(
      await test.db.query(
        `SELECT k.CONSTRAINT_NAME AS constraintName,
                GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS columns,
                GROUP_CONCAT(k.REFERENCED_COLUMN_NAME
                             ORDER BY k.ORDINAL_POSITION) AS referencedColumns,
                r.DELETE_RULE AS deleteRule
           FROM information_schema.key_column_usage AS k
           JOIN information_schema.referential_constraints AS r
             ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
            AND r.TABLE_NAME = k.TABLE_NAME
            AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          WHERE k.CONSTRAINT_SCHEMA = DATABASE()
            AND k.CONSTRAINT_NAME = 'purchase_transactions_product_seller_foreign'
          GROUP BY k.CONSTRAINT_NAME, r.DELETE_RULE`,
      ),
    ).toEqual([
      {
        constraintName: 'purchase_transactions_product_seller_foreign',
        columns: 'product_id,seller_user_id',
        referencedColumns: 'product_id,user_id',
        deleteRule: 'RESTRICT',
      },
    ]);
  });

  it('enforces listing identity, fingerprint, seller scope and deletion-state checks', async () => {
    await insertPrincipals(test.db);
    await test.db.execute(`INSERT INTO stores
      (store_id, user_id, name, description, level, points, sync_status)
      VALUES ('migration-other-store', 'migration-other', '別店舗', '',
              1, 0, 'connected')`);
    await runMigrations(test.db, migrations);

    const insertListing = (
      productId: string,
      storeId: string,
      sellerId: string,
      requestId: string | null,
      fingerprint: string | null,
      status: 'available' | 'sold' = 'available',
      deletedAt: string | null = null,
    ) =>
      test.db.execute(
        `INSERT INTO products
          (product_id, store_id, user_id, name, description, price, stock,
           status, listing_request_id, listing_request_fingerprint,
           deleted_at, category, theme, emoji)
         VALUES (?, ?, ?, ?, '', 1000, ?, ?, ?, ?, ?,
                 'hobby', 'forest', '📦')`,
        [
          productId,
          storeId,
          sellerId,
          productId,
          status === 'available' ? 1 : 0,
          status,
          requestId,
          fingerprint,
          deletedAt,
        ],
      );
    const fingerprint = 'a'.repeat(64);

    await expect(
      insertListing(
        'fingerprint-valid-64',
        'migration-store',
        'migration-seller',
        'fingerprint-valid-64',
        fingerprint,
      ),
    ).resolves.toMatchObject({ affectedRows: 1 });

    await expect(
      insertListing(
        'bad-listing-id',
        'migration-store',
        'migration-seller',
        'contains a space',
        fingerprint,
      ),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    const requestIdAtLimit = 'r'.repeat(100);
    await expect(
      insertListing(
        'listing-id-valid-100',
        'migration-store',
        'migration-seller',
        requestIdAtLimit,
        fingerprint,
      ),
    ).resolves.toMatchObject({ affectedRows: 1 });
    for (const [productId, requestId] of [
      ['listing-id-over-limit', 'r'.repeat(101)],
      ['listing-id-line-feed', `${requestIdAtLimit}\n`],
      ['listing-id-carriage-return', `${requestIdAtLimit}\r`],
      ['listing-id-trailing-space', `${requestIdAtLimit} `],
    ] as const) {
      await expect(
        insertListing(
          productId,
          'migration-store',
          'migration-seller',
          requestId,
          fingerprint,
        ),
      ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    }
    for (const [productId, invalidFingerprint] of [
      ['fingerprint-63-hex', 'a'.repeat(63)],
      ['fingerprint-65-hex', 'a'.repeat(65)],
      ['fingerprint-line-feed', `${fingerprint}\n`],
      ['fingerprint-carriage-return', `${fingerprint}\r`],
      ['fingerprint-trailing-space', `${fingerprint} `],
      ['fingerprint-uppercase', 'A'.repeat(64)],
    ] as const) {
      await expect(
        insertListing(
          productId,
          'migration-store',
          'migration-seller',
          productId,
          invalidFingerprint,
        ),
      ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    }
    await expect(
      insertListing(
        'one-sided-listing',
        'migration-store',
        'migration-seller',
        'one-sided-listing',
        null,
      ),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    await expect(
      insertListing(
        'deleted-sold',
        'migration-store',
        'migration-seller',
        null,
        null,
        'sold',
        '2026-09-25 00:00:00',
      ),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });

    await insertListing(
      'listing-first',
      'migration-store',
      'migration-seller',
      'shared-listing-id',
      fingerprint,
    );
    await expect(
      insertListing(
        'listing-duplicate',
        'migration-store',
        'migration-seller',
        'shared-listing-id',
        'b'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(
      insertListing(
        'listing-other-seller',
        'migration-other-store',
        'migration-other',
        'shared-listing-id',
        'c'.repeat(64),
      ),
    ).resolves.toMatchObject({ affectedRows: 1 });
  });

  it('enforces one transaction per product, exact seller identity and binary request IDs', async () => {
    await insertPrincipals(test.db);
    await runMigrations(test.db, migrations);
    for (const productId of [
      'transaction-product-a',
      'transaction-product-b',
      'transaction-product-c',
      'transaction-product-d',
    ]) {
      await insertLegacyProduct(test.db, productId, 0, 1000);
    }
    await insertTransaction(
      test.db,
      'transaction-a',
      'transaction-product-a',
      'Case-sensitive',
      1000,
    );
    await expect(
      insertTransaction(
        test.db,
        'transaction-a-duplicate',
        'transaction-product-a',
        'different-request',
        1000,
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(
      insertTransaction(
        test.db,
        'transaction-wrong-seller',
        'transaction-product-b',
        'wrong-seller',
        1000,
        'migration-other',
      ),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    await insertTransaction(
      test.db,
      'transaction-b',
      'transaction-product-b',
      'case-sensitive',
      1000,
    );
    await insertTransaction(
      test.db,
      'transaction-c',
      'transaction-product-c',
      'trailing-space',
      1000,
    );
    await insertTransaction(
      test.db,
      'transaction-d',
      'transaction-product-d',
      'trailing-space ',
      1000,
    );
    expect(
      await test.db.query<{ request_id: string }>(
        `SELECT request_id FROM purchase_transactions ORDER BY transaction_id`,
      ),
    ).toEqual([
      { request_id: 'Case-sensitive' },
      { request_id: 'case-sensitive' },
      { request_id: 'trailing-space' },
      { request_id: 'trailing-space ' },
    ]);
  });
});
