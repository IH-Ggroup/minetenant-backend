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
    } finally {
      await test.db.execute('DROP TRIGGER hono_test_fail_listing');
    }
    await expectStatus(await create(seller, payload), 201);
    expect(await listingRows(payload.requestId)).toHaveLength(1);
  });
});
