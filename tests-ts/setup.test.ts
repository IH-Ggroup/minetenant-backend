import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate.js';
import { seedDemo } from '../scripts/seed.js';
import { PRODUCT_STATUS_TRIGGER_CONTRACTS } from '../src/db/product-status-trigger-contract.js';
import {
  assertDatabaseReady,
  inspectDatabaseReadiness,
} from '../src/readiness.js';
import {
  assertTestDatabaseIsolation,
  createTestApp,
  type TestApp,
} from './helpers.js';

const businessTables = ['users', 'stores', 'products', 'purchase_transactions'];
const primaryKeys = {
  users: 'user_id',
  stores: 'store_id',
  products: 'product_id',
  purchase_transactions: 'transaction_id',
} as const;

describe('safe migration and initial data setup', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });
  beforeEach(async () => {
    await test.reset();
  });
  afterAll(async () => {
    await test?.close();
  });

  async function clearDatabase() {
    // createTestApp verifies this is the dedicated test database before any mutation.
    await test.db.transaction(async (tx) => {
      await tx.execute(`UPDATE products
        SET listing_request_id = NULL, listing_request_fingerprint = NULL
        WHERE listing_request_id IS NOT NULL
           OR listing_request_fingerprint IS NOT NULL`);
      for (const table of [
        'hono_sessions',
        'hono_rate_limits',
        ...businessTables.toReversed(),
      ]) {
        await tx.execute(`DELETE FROM ${table}`);
      }
    });
  }

  async function snapshot() {
    return Promise.all(
      businessTables.map(async (table) => ({
        table,
        schema: await test.db.query(`SHOW CREATE TABLE ${table}`),
        rows: await test.db.query(
          `SELECT * FROM ${table} ORDER BY ${primaryKeys[table as keyof typeof primaryKeys]}`,
        ),
      })),
    );
  }

  async function rowCounts() {
    return Promise.all(
      businessTables.map(async (table) => {
        const [row] = await test.db.query<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${table}`,
        );
        return row!.count;
      }),
    );
  }

  it('preserves existing schemas, passwords, product state, growth and history when rerun', async () => {
    const changedPassword = (
      await bcrypt.hash('user-changed-password', 4)
    ).replace('$2b$', '$2y$');
    await test.db.execute(
      "UPDATE users SET password = ?, name = '既存ユーザー' WHERE user_id = 'user-buyer'",
      [changedPassword],
    );
    await test.db.execute(
      "UPDATE products SET price = 9100 WHERE product_id = 'product-stool'",
    );
    await test.db.execute(
      "UPDATE stores SET points = 1234, level = 5 WHERE store_id = 'store-mine'",
    );
    await test.db.execute(
      "UPDATE purchase_transactions SET status = 'complete' WHERE transaction_id = 'transaction-demo'",
    );
    const before = await snapshot();

    await migrate(test.db);
    expect(await seedDemo(test.db, 4)).toBe(false);
    await migrate(test.db);
    expect(await seedDemo(test.db, 4)).toBe(false);

    expect(await snapshot()).toEqual(before);
  });

  it('does not inject or overwrite demo records when only one existing user is present', async () => {
    await test.db.transaction(async (tx) => {
      for (const table of ['purchase_transactions', 'products', 'stores']) {
        await tx.execute(`DELETE FROM ${table}`);
      }
      await tx.execute("DELETE FROM users WHERE user_id <> 'user-buyer'");
    });
    const before = await snapshot();
    expect(await seedDemo(test.db, 4)).toBe(false);
    expect(await rowCounts()).toEqual([1, 0, 0, 0]);
    expect(await snapshot()).toEqual(before);
  });

  it('seeds the empty schema with the existing demo records and usable bcrypt passwords', async () => {
    await clearDatabase();
    expect(await seedDemo(test.db, 4)).toBe(true);
    expect(await rowCounts()).toEqual([2, 2, 6, 1]);
    const users = await test.db.query<{ password: string }>(
      'SELECT password FROM users',
    );
    for (const user of users) {
      expect(user.password).not.toBe('password');
      expect(await bcrypt.compare('password', user.password)).toBe(true);
    }
    const [history] = await test.db.query<{
      request_id: string;
      status: string;
      amount: number;
    }>('SELECT request_id, status, amount FROM purchase_transactions');
    expect(history).toEqual({
      request_id: 'request-demo',
      status: 'shipping',
      amount: 4200,
    });
    expect(
      await test.db.query(
        `SELECT product_id, status, stock, listing_request_id,
                listing_request_fingerprint, deleted_at
           FROM products ORDER BY product_id`,
      ),
    ).toEqual([
      {
        product_id: 'product-hoodie',
        status: 'available',
        stock: 1,
        listing_request_id: null,
        listing_request_fingerprint: null,
        deleted_at: null,
      },
      {
        product_id: 'product-lamp',
        status: 'available',
        stock: 1,
        listing_request_id: null,
        listing_request_fingerprint: null,
        deleted_at: null,
      },
      {
        product_id: 'product-notebook',
        status: 'sold',
        stock: 0,
        listing_request_id: null,
        listing_request_fingerprint: null,
        deleted_at: null,
      },
      {
        product_id: 'product-pendant',
        status: 'available',
        stock: 1,
        listing_request_id: null,
        listing_request_fingerprint: null,
        deleted_at: null,
      },
      {
        product_id: 'product-stool',
        status: 'sold',
        stock: 0,
        listing_request_id: null,
        listing_request_fingerprint: null,
        deleted_at: null,
      },
      {
        product_id: 'product-toolbag',
        status: 'available',
        stock: 1,
        listing_request_id: null,
        listing_request_fingerprint: null,
        deleted_at: null,
      },
    ]);
  });

  it('keeps the database constraints that prevent lost history, invalid stock and duplicate purchases', async () => {
    const before = await snapshot();
    await expect(
      test.db.execute(
        "DELETE FROM products WHERE product_id = 'product-stool'",
      ),
    ).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
    await expect(
      test.db.execute(
        "UPDATE products SET stock = -1 WHERE product_id = 'product-hoodie'",
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(
        /ER_(WARN_DATA_OUT_OF_RANGE|SIGNAL_EXCEPTION)/,
      ),
    });
    await expect(
      test.db.execute(`INSERT INTO purchase_transactions
            (transaction_id, request_id, product_id, buyer_user_id, seller_user_id, source, amount, status)
            VALUES ('duplicate-transaction', 'request-demo', 'product-stool', 'user-buyer', 'user-seller', 'web', 4200, 'paid')`),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(
      test.db.execute(`INSERT INTO purchase_transactions
            (transaction_id, request_id, product_id, buyer_user_id, seller_user_id, source, amount, status)
            VALUES ('orphan-transaction', 'orphan-request', 'missing', 'user-buyer', 'user-seller', 'web', 4200, 'paid')`),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    await expect(
      test.db.execute(`INSERT INTO stores (store_id, user_id, name, description)
            VALUES ('duplicate-store', 'user-buyer', 'Duplicate store', '')`),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    [
      'product price',
      "UPDATE products SET price = 0 WHERE product_id = 'product-hoodie'",
    ],
    [
      'product category',
      "UPDATE products SET category = 'unknown' WHERE product_id = 'product-hoodie'",
    ],
    [
      'product theme',
      "UPDATE products SET theme = 'unknown' WHERE product_id = 'product-hoodie'",
    ],
    [
      'transaction buyer and seller identity',
      `UPDATE purchase_transactions
          SET buyer_user_id = seller_user_id
        WHERE transaction_id = 'transaction-demo'`,
    ],
    [
      'transaction source',
      `UPDATE purchase_transactions SET source = 'legacy'
        WHERE transaction_id = 'transaction-demo'`,
    ],
    [
      'transaction status',
      `UPDATE purchase_transactions SET status = 'unknown'
        WHERE transaction_id = 'transaction-demo'`,
    ],
    [
      'transaction amount',
      `UPDATE purchase_transactions SET amount = 0
        WHERE transaction_id = 'transaction-demo'`,
    ],
  ] as const)(
    'enforces the %s CHECK in the migrated schema',
    async (_name, sql) => {
      await expect(test.db.execute(sql)).rejects.toMatchObject({
        code: 'ER_CHECK_CONSTRAINT_VIOLATED',
      });
    },
  );

  it('rejects startup readiness when a compatibility trigger is missing or modified', async () => {
    const trigger = PRODUCT_STATUS_TRIGGER_CONTRACTS.find(
      ({ event }) => event === 'UPDATE',
    )!;
    const createTrigger = (statement: string) =>
      test.db.execute(
        `CREATE TRIGGER \`${trigger.name}\` ${trigger.timing} ${trigger.event}
         ON \`${trigger.table}\` FOR EACH ROW ${statement}`,
      );

    await test.db.execute(`DROP TRIGGER \`${trigger.name}\``);
    try {
      await expect(
        assertDatabaseReady(test.db, test.config.dbDatabase),
      ).rejects.toMatchObject({ code: 'MINETENANT_SCHEMA_MISMATCH' });

      await createTrigger('BEGIN SET NEW.name = NEW.name; END');
      await expect(
        assertDatabaseReady(test.db, test.config.dbDatabase),
      ).rejects.toMatchObject({ code: 'MINETENANT_SCHEMA_MISMATCH' });
    } finally {
      await test.db.execute(`DROP TRIGGER IF EXISTS \`${trigger.name}\``);
      await createTrigger(trigger.statement);
    }

    await expect(
      assertDatabaseReady(test.db, test.config.dbDatabase),
    ).resolves.toMatchObject({ invalidTriggers: [] });

    await test.db.execute(`CREATE TRIGGER hono_test_unexpected_products_trigger
      AFTER UPDATE ON products FOR EACH ROW SET @product_changed = 1`);
    try {
      await expect(
        assertDatabaseReady(test.db, test.config.dbDatabase),
      ).rejects.toMatchObject({ code: 'MINETENANT_SCHEMA_MISMATCH' });
    } finally {
      await test.db.execute(
        'DROP TRIGGER hono_test_unexpected_products_trigger',
      );
    }

    await expect(
      assertDatabaseReady(test.db, test.config.dbDatabase),
    ).resolves.toMatchObject({ invalidTriggers: [] });
  });

  it('rejects startup readiness while a persistent migration audit table is missing', async () => {
    const auditTable = 'product_status_migration_product_audit';
    const temporarilyRenamedTable =
      'product_status_migration_product_audit_readiness_test';

    await test.db.execute(
      `RENAME TABLE ${auditTable} TO ${temporarilyRenamedTable}`,
    );
    try {
      const readiness = await inspectDatabaseReadiness(
        test.db,
        test.config.dbDatabase,
      );
      expect(readiness.missingTables).toContain(auditTable);
      await expect(
        assertDatabaseReady(test.db, test.config.dbDatabase),
      ).rejects.toMatchObject({
        code: 'MINETENANT_SCHEMA_MISMATCH',
      });
    } finally {
      await test.db.execute(
        `RENAME TABLE ${temporarilyRenamedTable} TO ${auditTable}`,
      );
    }

    await expect(
      assertDatabaseReady(test.db, test.config.dbDatabase),
    ).resolves.toMatchObject({ missingTables: [] });
  });

  it('rejects cascading foreign keys and triggers added to persistent audit tables', async () => {
    const auditTable = 'product_status_migration_product_audit';
    const foreignKey = 'readiness_test_audit_product_foreign';
    const trigger = 'readiness_test_audit_delete_trigger';

    await test.db.execute(`ALTER TABLE ${auditTable}
      ADD CONSTRAINT ${foreignKey} FOREIGN KEY (product_id)
      REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE RESTRICT`);
    try {
      const readiness = await inspectDatabaseReadiness(
        test.db,
        test.config.dbDatabase,
      );
      expect(readiness.invalidTables).toContain(auditTable);
      await expect(
        assertDatabaseReady(test.db, test.config.dbDatabase),
      ).rejects.toMatchObject({ code: 'MINETENANT_SCHEMA_MISMATCH' });
    } finally {
      await test.db.execute(
        `ALTER TABLE ${auditTable} DROP FOREIGN KEY ${foreignKey}`,
      );
    }

    await test.db.execute(`CREATE TRIGGER ${trigger}
      BEFORE DELETE ON ${auditTable} FOR EACH ROW SET @audit_deleted = 1`);
    try {
      const readiness = await inspectDatabaseReadiness(
        test.db,
        test.config.dbDatabase,
      );
      expect(readiness.invalidTables).toContain(auditTable);
      await expect(
        assertDatabaseReady(test.db, test.config.dbDatabase),
      ).rejects.toMatchObject({ code: 'MINETENANT_SCHEMA_MISMATCH' });
    } finally {
      await test.db.execute(`DROP TRIGGER ${trigger}`);
    }

    await expect(
      assertDatabaseReady(test.db, test.config.dbDatabase),
    ).resolves.toMatchObject({ invalidTables: [] });
  });

  it('rolls back the whole seed if its last transaction insert fails, then permits a clean retry', async () => {
    await clearDatabase();
    await test.db
      .execute(`CREATE TRIGGER hono_test_seed_failure BEFORE INSERT ON purchase_transactions
            FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Intentional full seed rollback test'`);
    try {
      await expect(seedDemo(test.db, 4)).rejects.toMatchObject({
        code: 'ER_SIGNAL_EXCEPTION',
      });
      expect(await rowCounts()).toEqual([0, 0, 0, 0]);
    } finally {
      await test.db.execute('DROP TRIGGER hono_test_seed_failure');
    }
    expect(await seedDemo(test.db, 4)).toBe(true);
    expect(await rowCounts()).toEqual([2, 2, 6, 1]);
  });
});

describe('setup command boundaries', () => {
  it('enables local trigger creation in the manual administrator SQL without granting SUPER', async () => {
    const setupSql = await readFile(
      fileURLToPath(new URL('../database/setup-local.sql', import.meta.url)),
      'utf8',
    );
    expect(setupSql).toContain(
      'SET GLOBAL log_bin_trust_function_creators = 1;',
    );
    expect(setupSql).not.toMatch(/GRANT\s+SUPER\b/i);
    expect(setupSql.indexOf('SET GLOBAL')).toBeLessThan(
      setupSql.indexOf('CREATE DATABASE'),
    );
  });

  it('refuses to reset the configured development database', () => {
    expect(() =>
      assertTestDatabaseIsolation({ DB_DATABASE: 'MineTenant_Test' }),
    ).toThrow('npm test resets that database');
    expect(() =>
      assertTestDatabaseIsolation({ DB_DATABASE: 'minetenant' }),
    ).not.toThrow();
  });

  it('rejects production setup and seeding before database access and preserves the existing env file', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'minetenant-hono-setup-test-'),
    );
    const original =
      'APP_ENV=local\n# Existing environment must remain unchanged.\n';
    try {
      await writeFile(join(directory, '.env'), original);
      await writeFile(
        join(directory, '.env.example'),
        'APP_ENV=local\n# Must not replace existing env.\n',
      );
      for (const script of ['setup', 'seed']) {
        const result = spawnSync(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            fileURLToPath(new URL(`../scripts/${script}.ts`, import.meta.url)),
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              APP_ENV: 'production',
              DB_CONNECTION: 'mysql',
              DB_HOST: '127.0.0.1',
              DB_PORT: '1',
              DB_DATABASE: 'minetenant_test',
              DB_USERNAME: 'unused',
              DB_PASSWORD: 'unused',
              DB_URL: '',
            },
            encoding: 'utf8',
            timeout: 5000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('APP_ENV=local');
        expect(result.stderr).not.toContain('ECONNREFUSED');
      }
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps environment generation in npm run dev instead of copying fixed template credentials', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'minetenant-env-entrypoint-test-'),
    );
    try {
      await writeFile(
        join(directory, '.env.example'),
        'APP_ENV=local\nDB_USERNAME=minetenant\nDB_PASSWORD=minetenant\n',
      );
      for (const script of ['setup', 'db-bootstrap']) {
        const result = spawnSync(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            fileURLToPath(new URL(`../scripts/${script}.ts`, import.meta.url)),
          ],
          {
            cwd: directory,
            env: { ...process.env, MYSQL_ADMIN_PASSWORD: '' },
            encoding: 'utf8',
            timeout: 5000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('npm run dev');
      }
      await expect(readFile(join(directory, '.env'), 'utf8')).rejects.toThrow(
        /ENOENT/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('explains an unsafe remote administrator target before asking for credentials', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'minetenant-bootstrap-guard-test-'),
    );
    try {
      await writeFile(join(directory, '.env'), 'APP_ENV=local\n');
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('../scripts/db-bootstrap.ts', import.meta.url)),
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            APP_ENV: 'local',
            DB_HOST: 'db.example.test',
            MYSQL_ADMIN_PASSWORD: '',
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('localhost or 127.0.0.1');
      expect(result.stderr).not.toContain('DB_BOOTSTRAP_FAILED Error');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
