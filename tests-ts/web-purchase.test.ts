import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
  type TestClient,
} from './helpers.js';

async function body(response: Response, status = 200) {
  await expectStatus(response, status);
  return response.json();
}

describe('Web purchase API', () => {
  let test: TestApp;
  let buyer: TestClient;
  let seller: TestClient;

  beforeAll(async () => {
    test = await createTestApp();
  });

  beforeEach(async () => {
    await test.reset();
    buyer = createClient(test.app);
    seller = createClient(test.app);
    await expectStatus(await buyer.login(), 200);
    await expectStatus(await seller.login('seller'), 200);
  });

  afterAll(async () => {
    await test?.close();
  });

  it('uses the session buyer and returns the same transaction for a retry', async () => {
    const payload = { requestId: 'web-purchase-request' };
    const first = await body(
      await buyer.json(
        '/api/v1/products/PRODUCT-HOODIE/purchases',
        'POST',
        payload,
      ),
      201,
    );
    const retry = await body(
      await buyer.json(
        '/api/v1/products/product-hoodie/purchases',
        'POST',
        payload,
      ),
    );

    expect(retry).toEqual(first);
    expect(first.data).toMatchObject({
      productId: 'product-hoodie',
      buyerId: 'user-buyer',
      sellerId: 'user-seller',
      source: 'web',
      amount: 6800,
      status: 'paid',
    });
    expect(
      await test.db.query(
        "SELECT transaction_id FROM purchase_transactions WHERE request_id = 'web-purchase-request'",
      ),
    ).toHaveLength(1);
    const [product] = await test.db.query<{ status: string }>(
      "SELECT status FROM products WHERE product_id = 'product-hoodie'",
    );
    expect(product?.status).toBe('sold');
    const stores = await test.db.query<{ store_id: string; points: number }>(
      `SELECT store_id, points FROM stores
        WHERE store_id IN ('store-mine', 'store-yamada')
        ORDER BY store_id`,
    );
    expect(stores).toEqual([
      { store_id: 'store-mine', points: 520 },
      { store_id: 'store-yamada', points: 90 },
    ]);
  });

  it('keeps the compatibility path limited to productId and requestId', async () => {
    const payload = {
      productId: 'product-hoodie',
      requestId: 'compat-purchase-request',
    };
    const first = await body(
      await buyer.json('/api/v1/purchases', 'POST', payload),
      201,
    );
    expect(
      await body(await buyer.json('/api/v1/purchases', 'POST', payload)),
    ).toEqual(first);

    await test.reset();
    await expectStatus(await buyer.login(), 200);
    const invalid = await body(
      await buyer.json('/api/v1/purchases', 'POST', {
        ...payload,
        buyerId: 'user-seller',
        source: 'minecraft',
      }),
      422,
    );
    expect(invalid.errors).toMatchObject({
      buyerId: expect.any(Array),
      source: expect.any(Array),
    });
  });

  it('rejects every client-controlled purchase field on the canonical path', async () => {
    const invalid = await body(
      await buyer.json('/api/v1/products/product-hoodie/purchases', 'POST', {
        requestId: 'forged-purchase',
        productId: 'product-pendant',
        buyerId: 'user-seller',
        sellerId: 'user-buyer',
        source: 'minecraft',
        price: 1,
        status: 'complete',
      }),
      422,
    );
    expect(Object.keys(invalid.errors).sort()).toEqual(
      ['buyerId', 'price', 'productId', 'sellerId', 'source', 'status'].sort(),
    );
    const [product] = await test.db.query<{ status: string }>(
      "SELECT status FROM products WHERE product_id = 'product-hoodie'",
    );
    expect(product?.status).toBe('available');
    expect(
      await test.db.query(
        "SELECT transaction_id FROM purchase_transactions WHERE request_id = 'forged-purchase'",
      ),
    ).toHaveLength(0);
  });

  it('validates new request IDs without changing their raw value', async () => {
    const tooLongNewId = await body(
      await buyer.json('/api/v1/products/product-hoodie/purchases', 'POST', {
        requestId: 'a'.repeat(101),
      }),
      422,
    );
    expect(tooLongNewId.errors.requestId).toEqual([
      '新しい購入リクエストIDは英数字と._:-のみを使い、100文字以内で指定してください。',
    ]);

    for (const requestId of [
      ' request-with-space',
      'request-with-space ',
      '購入-request',
      'a'.repeat(256),
    ]) {
      const invalid = await body(
        await buyer.json('/api/v1/products/product-hoodie/purchases', 'POST', {
          requestId,
        }),
        422,
      );
      expect(invalid.errors).toHaveProperty('requestId');
    }

    await expectStatus(
      await buyer.json('/api/v1/products/product-hoodie/purchases', 'POST', {
        requestId: 'a'.repeat(100),
      }),
      201,
    );
  });

  it('replays an exact legacy request ID but never creates a new invalid ID', async () => {
    await test.db.execute(
      `UPDATE purchase_transactions
        SET request_id = ' legacy request ', source = 'web'
        WHERE transaction_id = 'transaction-demo'`,
    );
    const replay = await body(
      await buyer.json('/api/v1/products/product-stool/purchases', 'POST', {
        requestId: ' legacy request ',
      }),
    );
    expect(replay.data.id).toBe('transaction-demo');

    const changed = await body(
      await buyer.json('/api/v1/products/product-stool/purchases', 'POST', {
        requestId: 'legacy request',
      }),
      422,
    );
    expect(changed.errors).toHaveProperty('requestId');

    const conflict = await body(
      await seller.json('/api/v1/products/product-stool/purchases', 'POST', {
        requestId: ' legacy request ',
      }),
      409,
    );
    expect(conflict.code).toBe('REQUEST_ID_CONFLICT');
  });

  it('checks requestId conflicts before product existence and state', async () => {
    const requestId = 'conflict-before-product-state';
    await expectStatus(
      await buyer.json('/api/v1/products/product-hoodie/purchases', 'POST', {
        requestId,
      }),
      201,
    );
    await expectStatus(
      await buyer.json('/api/v1/products/product-lamp', 'DELETE'),
      204,
    );

    const conflicts = [
      buyer.json('/api/v1/products/missing/purchases', 'POST', { requestId }),
      buyer.json('/api/v1/products/product-lamp/purchases', 'POST', {
        requestId,
      }),
      buyer.json('/api/v1/products/product-pendant/purchases', 'POST', {
        requestId,
      }),
      buyer.json('/api/v1/purchases', 'POST', {
        productId: 'product-pendant',
        requestId,
      }),
    ];
    for (const response of await Promise.all(conflicts)) {
      const conflict = await body(response, 409);
      expect(conflict.code).toBe('REQUEST_ID_CONFLICT');
    }
  });

  it('requires a session and a matching CSRF token', async () => {
    const guest = createClient(test.app);
    await expectStatus(await guest.request('/api/v1/auth/csrf-cookie'), 204);
    await expectStatus(
      await guest.json('/api/v1/products/product-hoodie/purchases', 'POST', {
        requestId: 'guest-purchase',
      }),
      401,
    );
    await expectStatus(
      await buyer.request('/api/v1/products/product-hoodie/purchases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-XSRF-TOKEN': 'wrong-token',
        },
        body: JSON.stringify({ requestId: 'wrong-csrf' }),
      }),
      419,
    );
  });

  it('returns the contracted errors without changing purchase state', async () => {
    await expectStatus(
      await buyer.json('/api/v1/products/missing/purchases', 'POST', {
        requestId: 'missing-product',
      }),
      404,
    );

    const selfPurchase = await body(
      await seller.json('/api/v1/products/product-hoodie/purchases', 'POST', {
        requestId: 'self-purchase',
      }),
      422,
    );
    expect(selfPurchase.code).toBe('SELF_PURCHASE');

    const sold = await body(
      await buyer.json('/api/v1/products/product-stool/purchases', 'POST', {
        requestId: 'sold-product',
      }),
      409,
    );
    expect(sold.code).toBe('OUT_OF_STOCK');

    await expectStatus(
      await seller.json('/api/v1/products/product-hoodie', 'DELETE'),
      204,
    );
    // A fresh request ID still reports a soft-deleted product as not found.
    await expectStatus(
      await buyer.json('/api/v1/products/product-hoodie/purchases', 'POST', {
        requestId: 'deleted-product',
      }),
      404,
    );

    expect(
      await test.db.query(
        "SELECT transaction_id FROM purchase_transactions WHERE request_id IN ('missing-product', 'self-purchase', 'sold-product', 'deleted-product')",
      ),
    ).toHaveLength(0);
  });
});
