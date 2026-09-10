import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate.js';
import { seedDemo } from '../scripts/seed.js';
import { createTestApp, type TestApp } from './helpers.js';

const businessTables = ['users', 'stores', 'products', 'purchase_transactions'];

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
        rows: await test.db.query(`SELECT * FROM ${table} ORDER BY id`),
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

  it('preserves existing schemas, passwords, inventory, growth and history when rerun', async () => {
    const changedPassword = (
      await bcrypt.hash('user-changed-password', 4)
    ).replace('$2b$', '$2y$');
    await test.db.execute(
      "UPDATE users SET password = ?, name = '既存ユーザー' WHERE id = 'user-buyer'",
      [changedPassword],
    );
    await test.db.execute(
      "UPDATE products SET stock = 37, price = 9100 WHERE id = 'product-stool'",
    );
    await test.db.execute(
      "UPDATE stores SET points = 1234, level = 5 WHERE id = 'store-mine'",
    );
    await test.db.execute(
      "UPDATE purchase_transactions SET status = 'complete' WHERE id = 'transaction-demo'",
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
      await tx.execute("DELETE FROM users WHERE id <> 'user-buyer'");
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
  });

  it('keeps the database constraints that prevent lost history, invalid stock and duplicate purchases', async () => {
    const before = await snapshot();
    await expect(
      test.db.execute("DELETE FROM products WHERE id = 'product-stool'"),
    ).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
    await expect(
      test.db.execute(
        "UPDATE products SET stock = -1 WHERE id = 'product-hoodie'",
      ),
    ).rejects.toMatchObject({ code: 'ER_WARN_DATA_OUT_OF_RANGE' });
    await expect(
      test.db.execute(`INSERT INTO purchase_transactions
            (id, request_id, product_id, buyer_id, seller_id, source, amount, status)
            VALUES ('duplicate-transaction', 'request-demo', 'product-stool', 'user-buyer', 'user-seller', 'web', 4200, 'paid')`),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(
      test.db.execute(`INSERT INTO purchase_transactions
            (id, request_id, product_id, buyer_id, seller_id, source, amount, status)
            VALUES ('orphan-transaction', 'orphan-request', 'missing', 'user-buyer', 'user-seller', 'web', 4200, 'paid')`),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    await expect(
      test.db.execute(`INSERT INTO stores (id, owner_id, name, description)
            VALUES ('duplicate-store', 'user-buyer', 'Duplicate store', '')`),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(await snapshot()).toEqual(before);
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
              DB_DATABASE: 'minetenant_hono_migration_test',
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
});
