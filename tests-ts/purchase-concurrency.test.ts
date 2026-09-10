import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
} from './helpers.js';

describe('atomic MySQL purchases and deletion races', () => {
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

  function purchase(productId: string, buyerId: string, requestId: string) {
    return test.app.request('/api/v1/minecraft/purchases', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ productId, buyerId, requestId }),
    });
  }

  async function stock(productId: string) {
    const rows = await test.db.query<{ stock: number }>(
      'SELECT stock FROM products WHERE id = ?',
      [productId],
    );
    return rows[0]?.stock;
  }

  async function points(storeId: string) {
    const rows = await test.db.query<{ points: number }>(
      'SELECT points FROM stores WHERE id = ?',
      [storeId],
    );
    return rows[0]?.points;
  }

  async function transactions(requestId?: string) {
    return test.db.query<{
      id: string;
      product_id: string;
      buyer_id: string;
      source: string;
    }>(
      `SELECT id, product_id, buyer_id, source FROM purchase_transactions${requestId === undefined ? '' : ' WHERE request_id = ?'}`,
      requestId === undefined ? [] : [requestId],
    );
  }

  it('sells the last item exactly once to simultaneous distinct requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        purchase('product-toolbag', 'user-seller', `last-stock-${index}`),
      ),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 409),
    ).toHaveLength(7);
    for (const response of responses.filter((item) => item.status === 409)) {
      expect((await response.json()).code).toBe('OUT_OF_STOCK');
    }
    expect(await stock('product-toolbag')).toBe(0);
    expect(await points('store-yamada')).toBe(140);
    expect(await transactions()).toHaveLength(2);
  });

  it('deduplicates simultaneous retries even when the first request consumes the last item', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        purchase('product-toolbag', 'user-seller', 'concurrent-retry'),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    const payloads = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(new Set(payloads.map((payload) => payload.data.id)).size).toBe(1);
    expect(await transactions('concurrent-retry')).toHaveLength(1);
    expect(await stock('product-toolbag')).toBe(0);
    expect(await points('store-yamada')).toBe(140);
  });

  it('resolves simultaneous requestId reuse across different products as one purchase and one conflict', async () => {
    const responses = await Promise.all([
      purchase('product-hoodie', 'user-buyer', 'concurrent-conflict'),
      purchase('product-stool', 'user-buyer', 'concurrent-conflict'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      (await responses.find((response) => response.status === 409)!.json())
        .code,
    ).toBe('REQUEST_ID_CONFLICT');
    const history = await transactions('concurrent-conflict');
    expect(history).toHaveLength(1);
    expect(
      (await stock('product-hoodie'))! + (await stock('product-stool'))!,
    ).toBe(4);
    expect(await points('store-mine')).toBe(520);
    const winner = history[0]!.product_id;
    expect(await stock(winner)).toBe(winner === 'product-hoodie' ? 2 : 1);
  });

  it('serializes growth for different products belonging to the same store without lost points', async () => {
    const responses = await Promise.all([
      purchase('product-hoodie', 'user-buyer', 'parallel-hoodie'),
      purchase('product-stool', 'user-buyer', 'parallel-stool'),
    ]);
    for (const response of responses) await expectStatus(response, 201);
    expect(await stock('product-hoodie')).toBe(2);
    expect(await stock('product-stool')).toBe(1);
    expect(await points('store-mine')).toBe(620);
    const [store] = await test.db.query<{ level: number }>(
      "SELECT level FROM stores WHERE id = 'store-mine'",
    );
    expect(store?.level).toBe(4);
    expect(await transactions()).toHaveLength(3);
  });

  it('rolls stock, transaction and store growth back when the transaction insert fails', async () => {
    // A real SQL failure after the stock update verifies the actual transaction boundary.
    // The trigger exists only in the explicitly guarded disposable test database.
    await test.db.execute(`
      CREATE TRIGGER hono_test_fail_purchase BEFORE INSERT ON purchase_transactions
      FOR EACH ROW BEGIN
        IF NEW.request_id = 'forced-sql-failure' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Intentional purchase rollback test';
        END IF;
      END
    `);
    try {
      const failed = await purchase(
        'product-stool',
        'user-buyer',
        'forced-sql-failure',
      );
      expect(failed.status).toBe(500);
      expect(await stock('product-stool')).toBe(2);
      expect(await points('store-mine')).toBe(420);
      expect(await transactions('forced-sql-failure')).toHaveLength(0);
      expect(await transactions()).toHaveLength(1);
    } finally {
      await test.db.execute('DROP TRIGGER hono_test_fail_purchase');
    }
    await expectStatus(
      await purchase('product-stool', 'user-buyer', 'forced-sql-failure'),
      201,
    );
    expect(await stock('product-stool')).toBe(1);
    expect(await points('store-mine')).toBe(520);
  });

  it('rolls back the inserted transaction and stock when store growth fails', async () => {
    await test.db.execute(`
      CREATE TRIGGER hono_test_fail_growth BEFORE UPDATE ON stores
      FOR EACH ROW BEGIN
        IF NEW.id = 'store-mine' AND NEW.points <> OLD.points THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Intentional growth rollback test';
        END IF;
      END
    `);
    try {
      expect(
        (await purchase('product-stool', 'user-buyer', 'growth-failure'))
          .status,
      ).toBe(500);
      expect(await stock('product-stool')).toBe(2);
      expect(await points('store-mine')).toBe(420);
      expect(await transactions('growth-failure')).toHaveLength(0);
    } finally {
      await test.db.execute('DROP TRIGGER hono_test_fail_growth');
    }
  });

  it('keeps purchase history consistent when purchase and seller deletion race', async () => {
    const seller = createClient(test.app);
    await expectStatus(await seller.login('seller@minetenant.jp'), 200);
    const [bought, deleted] = await Promise.all([
      purchase('product-hoodie', 'user-buyer', 'delete-race'),
      seller.json('/api/v1/products/product-hoodie', 'DELETE'),
    ]);
    const history = await transactions('delete-race');
    if (bought.status === 201) {
      await expectStatus(deleted, 409);
      expect(await stock('product-hoodie')).toBe(2);
      expect(history).toHaveLength(1);
      expect(await points('store-mine')).toBe(520);
    } else {
      await expectStatus(deleted, 204);
      // A missing product is 422 during Minecraft input validation or 404 after row locking.
      expect([404, 422]).toContain(bought.status);
      expect(await stock('product-hoodie')).toBeUndefined();
      expect(history).toHaveLength(0);
      expect(await points('store-mine')).toBe(420);
    }
    expect(await transactions('request-demo')).toHaveLength(1);
  });
});
