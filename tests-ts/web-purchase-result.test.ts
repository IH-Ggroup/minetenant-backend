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

describe('Web purchase result API', () => {
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

  it('returns the same transaction DTO after a purchase response is lost', async () => {
    const requestId = 'web-result:request-1';
    const purchase = await body(
      await buyer.json('/api/v1/products/product-hoodie/purchases', 'POST', {
        requestId,
      }),
      201,
    );
    const result = await body(
      await buyer.request(
        `/api/v1/purchases/requests/${encodeURIComponent(requestId)}`,
      ),
    );

    expect(result).toEqual(purchase);
  });

  it('returns a saved purchase to its buyer without requiring a CSRF header', async () => {
    const result = await body(
      await buyer.request('/api/v1/purchases/requests/request-demo'),
    );
    expect(result.data).toMatchObject({
      id: 'transaction-demo',
      productId: 'product-stool',
      buyerId: 'user-buyer',
      sellerId: 'user-seller',
      source: 'minecraft',
      amount: 4200,
      status: 'shipping',
    });
  });

  it('uses the same 404 for another buyer and an unknown request ID', async () => {
    const otherBuyer = await body(
      await seller.request('/api/v1/purchases/requests/request-demo'),
      404,
    );
    const missing = await body(
      await seller.request('/api/v1/purchases/requests/missing-request'),
      404,
    );

    expect(otherBuyer).toEqual(missing);
    expect(missing).toEqual({ message: '購入結果が見つかりません。' });
  });

  it('requires authentication', async () => {
    const guest = createClient(test.app);
    await expectStatus(
      await guest.request('/api/v1/purchases/requests/request-demo'),
      401,
    );
  });

  it('does not change products, transactions or store points on repeated GETs', async () => {
    const state = async () => ({
      products: await test.db.query<{
        product_id: string;
        status: string;
        stock: number;
      }>(
        'SELECT product_id, status, stock FROM products ORDER BY BINARY product_id',
      ),
      transactions: await test.db.query<{
        transaction_id: string;
        status: string;
      }>(
        'SELECT transaction_id, status FROM purchase_transactions ORDER BY BINARY transaction_id',
      ),
      stores: await test.db.query<{ store_id: string; points: number }>(
        'SELECT store_id, points FROM stores ORDER BY BINARY store_id',
      ),
    });
    const before = await state();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expectStatus(
        await buyer.request('/api/v1/purchases/requests/request-demo'),
        200,
      );
    }

    expect(await state()).toEqual(before);
  });
});
