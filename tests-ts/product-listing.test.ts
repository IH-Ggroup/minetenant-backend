import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProductRow } from '../src/domain/types.js';
import { productListingFingerprint } from '../src/services/products.js';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
  type TestClient,
} from './helpers.js';

const listing = {
  requestId: 'listing-request',
  name: '鉱石モチーフのペンダント',
  description: '青い鉱石をイメージした手作りペンダントです。',
  price: 3200,
  category: 'accessory',
  theme: 'ocean',
  emoji: '💎',
} as const;

describe('idempotent single-item listings', () => {
  let test: TestApp;
  let seller: TestClient;
  let buyer: TestClient;

  beforeAll(async () => {
    test = await createTestApp();
  });
  beforeEach(async () => {
    await test.reset();
    seller = createClient(test.app);
    buyer = createClient(test.app);
    await expectStatus(await seller.login('seller'), 200);
    await expectStatus(await buyer.login(), 200);
  });
  afterAll(async () => {
    await test?.close();
  });

  function create(client: TestClient, payload: Record<string, unknown>) {
    return client.json('/api/v1/products', 'POST', payload);
  }

  function listingRows(requestId: string, sellerId = 'user-seller') {
    return test.db.query<ProductRow>(
      `SELECT * FROM products
        WHERE user_id = ? AND listing_request_id = ?`,
      [sellerId, requestId],
    );
  }

  async function storeGrowth(storeId = 'store-mine') {
    const [store] = await test.db.query<{ points: number; level: number }>(
      'SELECT points, level FROM stores WHERE store_id = ?',
      [storeId],
    );
    return store;
  }

  it('matches the documented SHA-256 fingerprint vector', () => {
    expect(productListingFingerprint(listing)).toBe(
      'adcbef587d9dea01e55944817c427fe41328abc42edaa097ef3a8b7ceddfa4ce',
    );
  });

  it('returns the same product with 200 for a sequential retry', async () => {
    const first = await create(seller, listing);
    await expectStatus(first, 201);
    const firstBody = await first.json();

    const retry = await create(seller, listing);
    await expectStatus(retry, 200);
    expect(await retry.json()).toEqual(firstBody);

    const rows = await listingRows(listing.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      product_id: firstBody.data.id,
      store_id: 'store-mine',
      user_id: 'user-seller',
      status: 'available',
      stock: 1,
      listing_request_fingerprint:
        'adcbef587d9dea01e55944817c427fe41328abc42edaa097ef3a8b7ceddfa4ce',
    });
    expect(rows[0]?.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    expect(await storeGrowth()).toEqual({ points: 430, level: 3 });
  });

  it('creates one product for eight simultaneous identical retries', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => create(seller, listing)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    const payloads = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(new Set(payloads.map((payload) => payload.data.id)).size).toBe(1);
    expect(await listingRows(listing.requestId)).toHaveLength(1);
    expect(await storeGrowth()).toEqual({ points: 430, level: 3 });
  });

  it('rewards only the first three distinct listings of the JST day', async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        create(seller, {
          ...listing,
          requestId: `daily-listing-${index}`,
          name: `日次出品 ${index}`,
        }),
      ),
    );
    for (const response of responses) await expectStatus(response, 201);

    expect(await storeGrowth()).toEqual({ points: 450, level: 3 });
    const [count] = await test.db.query<{ listing_count: number }>(
      `SELECT COUNT(*) AS listing_count
         FROM products
        WHERE user_id = 'user-seller'
          AND listing_request_id LIKE 'daily-listing-%'`,
    );
    expect(Number(count?.listing_count)).toBe(4);
  });

  it('counts sold and deleted listings toward the daily reward limit', async () => {
    const createdIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await create(seller, {
        ...listing,
        requestId: `consumed-slot-${index}`,
      });
      await expectStatus(response, 201);
      createdIds.push((await response.json()).data.id as string);
    }
    await expectStatus(
      await seller.json(`/api/v1/products/${createdIds[0]}`, 'DELETE'),
      204,
    );
    await expectStatus(
      await buyer.json(`/api/v1/products/${createdIds[1]}/purchases`, 'POST', {
        requestId: 'purchase-consumed-slot',
      }),
      201,
    );
    expect(await storeGrowth()).toEqual({ points: 550, level: 3 });

    await expectStatus(
      await create(seller, {
        ...listing,
        requestId: 'after-consumed-slots',
      }),
      201,
    );
    expect(await storeGrowth()).toEqual({ points: 550, level: 3 });
  });

  it('uses JST day boundaries and excludes legacy listings', async () => {
    await test.db.execute(`INSERT INTO products
      (product_id, store_id, user_id, name, description, price, stock,
       status, category, theme, emoji, listing_request_id,
       listing_request_fingerprint, created_at, updated_at)
      VALUES
      ('previous-jst-listing', 'store-mine', 'user-seller', '前日', '', 1, 1,
       'available', 'hobby', 'forest', '🌲', 'previous-jst-request',
       REPEAT('a', 64),
       TIMESTAMP(DATE(UTC_TIMESTAMP(6) + INTERVAL 9 HOUR))
         - INTERVAL 9 HOUR - INTERVAL 1 SECOND,
       UTC_TIMESTAMP(6)),
      ('today-jst-listing', 'store-mine', 'user-seller', '当日', '', 1, 1,
       'available', 'hobby', 'forest', '🌲', 'today-jst-request',
       REPEAT('b', 64),
       TIMESTAMP(DATE(UTC_TIMESTAMP(6) + INTERVAL 9 HOUR))
         - INTERVAL 9 HOUR,
       UTC_TIMESTAMP(6)),
      ('legacy-today-listing', 'store-mine', 'user-seller', '旧出品', '', 1, 1,
       'available', 'hobby', 'forest', '🌲', NULL, NULL,
       UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`);

    for (const requestId of ['boundary-new-1', 'boundary-new-2']) {
      await expectStatus(await create(seller, { ...listing, requestId }), 201);
    }
    expect(await storeGrowth()).toEqual({ points: 440, level: 3 });

    await expectStatus(
      await create(seller, { ...listing, requestId: 'boundary-capped' }),
      201,
    );
    expect(await storeGrowth()).toEqual({ points: 440, level: 3 });
  });

  it('recomputes the level when listing points cross a threshold', async () => {
    await test.db.execute(
      "UPDATE stores SET points = 99, level = 1 WHERE store_id = 'store-mine'",
    );

    await expectStatus(await create(seller, listing), 201);

    expect(await storeGrowth()).toEqual({ points: 109, level: 2 });
  });

  it('rejects sequential and simultaneous requestId reuse with different content', async () => {
    await expectStatus(await create(seller, listing), 201);
    const conflict = await create(seller, {
      ...listing,
      name: '別の商品',
    });
    await expectStatus(conflict, 409);
    expect(await conflict.json()).toMatchObject({
      code: 'REQUEST_ID_CONFLICT',
      errors: { requestId: expect.any(Array) },
    });

    const concurrentRequestId = 'concurrent-content-conflict';
    const concurrent = await Promise.all([
      create(seller, { ...listing, requestId: concurrentRequestId }),
      create(seller, {
        ...listing,
        requestId: concurrentRequestId,
        price: listing.price + 1,
      }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(await listingRows(concurrentRequestId)).toHaveLength(1);
  });

  it('does not add points when input validation fails', async () => {
    const response = await create(seller, { ...listing, price: 0 });

    await expectStatus(response, 422);
    expect(await listingRows(listing.requestId)).toHaveLength(0);
    expect(await storeGrowth()).toEqual({ points: 420, level: 3 });
  });

  it('keeps one retired tombstone and prioritizes content conflicts', async () => {
    const created = await create(seller, listing);
    await expectStatus(created, 201);
    const productId = (await created.json()).data.id as string;
    await expectStatus(
      await seller.json(`/api/v1/products/${productId}`, 'DELETE'),
      204,
    );

    const retired = await create(seller, listing);
    await expectStatus(retired, 409);
    expect(await retired.json()).toEqual({
      message:
        'このrequestIdで作成した商品は削除済みです。新しい出品操作を開始してください。',
      code: 'LISTING_REQUEST_RETIRED',
    });
    const conflict = await create(seller, { ...listing, name: '別の商品' });
    await expectStatus(conflict, 409);
    expect((await conflict.json()).code).toBe('REQUEST_ID_CONFLICT');

    const rows = await listingRows(listing.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).not.toBeNull();
  });

  it('replays the current sold state without creating another product', async () => {
    const created = await create(seller, listing);
    await expectStatus(created, 201);
    const productId = (await created.json()).data.id as string;
    await expectStatus(
      await buyer.json(`/api/v1/products/${productId}/purchases`, 'POST', {
        requestId: 'buy-listed-product',
      }),
      201,
    );

    const retry = await create(seller, listing);
    await expectStatus(retry, 200);
    expect((await retry.json()).data).toMatchObject({
      id: productId,
      status: 'sold',
    });
    expect(await listingRows(listing.requestId)).toHaveLength(1);
  });

  it('scopes the same requestId to each authenticated seller', async () => {
    const responses = await Promise.all([
      create(seller, listing),
      create(buyer, listing),
    ]);
    for (const response of responses) await expectStatus(response, 201);
    const payloads = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(new Set(payloads.map((payload) => payload.data.id)).size).toBe(2);
    expect(await listingRows(listing.requestId, 'user-seller')).toHaveLength(1);
    expect(await listingRows(listing.requestId, 'user-buyer')).toHaveLength(1);
    expect(await storeGrowth('store-mine')).toEqual({ points: 430, level: 3 });
    expect(await storeGrowth('store-yamada')).toEqual({ points: 50, level: 1 });
  });

  it('returns USER_STORE_NOT_READY without creating a product', async () => {
    await test.db.execute('DELETE FROM purchase_transactions');
    await test.db.execute('DELETE FROM products');
    await test.db.execute("DELETE FROM stores WHERE store_id = 'store-mine'");

    const response = await create(seller, listing);
    await expectStatus(response, 409);
    expect(await response.json()).toMatchObject({
      code: 'USER_STORE_NOT_READY',
    });
    expect(await listingRows(listing.requestId)).toHaveLength(0);
  });

  it('rolls back a failed insert and permits a safe retry', async () => {
    await test.db.execute(`
      CREATE TRIGGER hono_test_fail_listing BEFORE INSERT ON products
      FOR EACH ROW BEGIN
        IF NEW.listing_request_id = 'failed-listing' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Intentional listing failure';
        END IF;
      END
    `);
    const payload = { ...listing, requestId: 'failed-listing' };
    try {
      await expectStatus(await create(seller, payload), 500);
      expect(await listingRows(payload.requestId)).toHaveLength(0);
      expect(await storeGrowth()).toEqual({ points: 420, level: 3 });
    } finally {
      await test.db.execute('DROP TRIGGER hono_test_fail_listing');
    }
    await expectStatus(await create(seller, payload), 201);
    expect(await listingRows(payload.requestId)).toHaveLength(1);
    expect(await storeGrowth()).toEqual({ points: 430, level: 3 });
  });

  it('rolls back the product when the store growth update fails', async () => {
    await test.db.execute(`
      CREATE TRIGGER hono_test_fail_listing_growth BEFORE UPDATE ON stores
      FOR EACH ROW BEGIN
        IF NEW.store_id = 'store-mine' AND NEW.points <> OLD.points THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Intentional growth failure';
        END IF;
      END
    `);
    const payload = { ...listing, requestId: 'failed-listing-growth' };
    try {
      await expectStatus(await create(seller, payload), 500);
      expect(await listingRows(payload.requestId)).toHaveLength(0);
      expect(await storeGrowth()).toEqual({ points: 420, level: 3 });
    } finally {
      await test.db.execute('DROP TRIGGER hono_test_fail_listing_growth');
    }

    await expectStatus(await create(seller, payload), 201);
    expect(await listingRows(payload.requestId)).toHaveLength(1);
    expect(await storeGrowth()).toEqual({ points: 430, level: 3 });
  });
});
