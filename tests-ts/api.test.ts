import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
  type TestClient,
} from './helpers.js';

const productPayload = {
  name: 'テスト用ツールセット',
  description: 'APIの出品フローを確認するための商品です。',
  price: 2500,
  stock: 3,
  category: 'tool',
  theme: 'moss',
  emoji: '🧰',
};

async function body(response: Response, status = 200) {
  await expectStatus(response, status);
  return response.json();
}

describe('Laravel API compatibility on MySQL', () => {
  let test: TestApp;
  let buyer: TestClient;
  let seller: TestClient;
  let guest: TestClient;

  beforeAll(async () => {
    test = await createTestApp();
  });
  beforeEach(async () => {
    await test.reset();
    buyer = createClient(test.app);
    seller = createClient(test.app);
    guest = createClient(test.app);
    await expectStatus(await buyer.login(), 200);
    await expectStatus(await seller.login('seller@minetenant.jp'), 200);
  });
  afterAll(async () => {
    await test?.close();
  });

  it('rejects bracketed multipart identity/source fields instead of replacing them with defaults', async () => {
    const listing = new FormData();
    for (const [key, value] of Object.entries(productPayload)) {
      listing.set(key, String(value));
    }
    listing.set('sellerId[]', 'user-buyer');
    const invalidSeller = await body(
      await seller.request('/api/v1/products', {
        method: 'POST',
        body: listing,
      }),
      422,
    );
    expect(invalidSeller.errors).toHaveProperty('sellerId');

    const purchase = new FormData();
    purchase.set('productId', 'product-stool');
    purchase.set('requestId', 'multipart-source');
    purchase.set('source[]', 'minecraft');
    const invalidSource = await body(
      await buyer.request('/api/v1/purchases', {
        method: 'POST',
        body: purchase,
      }),
      422,
    );
    expect(invalidSource.errors).toHaveProperty('source');
    expect(
      (await body(await guest.request('/api/v1/products'))).data,
    ).toHaveLength(6);
    expect(
      (await body(await guest.request('/api/v1/products/product-stool'))).data
        .stock,
    ).toBe(2);
  });

  it("matches PHP's last-value precedence for duplicate scalar and bracketed query fields", async () => {
    const scalarLast = await body(
      await guest.request('/api/v1/products?keyword[]=x&keyword=stool'),
    );
    expect(scalarLast.data).toEqual([]);
    const arrayLast = await body(
      await guest.request('/api/v1/products?keyword=stool&keyword[]=x'),
      422,
    );
    expect(arrayLast.errors).toHaveProperty('keyword');
  });

  it('canonicalizes case-insensitive MySQL route IDs before comparing purchase retries', async () => {
    const payload = { requestId: 'uppercase-route' };
    const first = await body(
      await buyer.json(
        '/api/v1/products/PRODUCT-STOOL/purchases',
        'POST',
        payload,
      ),
      201,
    );
    expect(first.data.productId).toBe('product-stool');
    expect(
      await body(
        await buyer.json(
          '/api/v1/products/PRODUCT-STOOL/purchases',
          'POST',
          payload,
        ),
      ),
    ).toEqual(first);
    expect(
      await body(
        await buyer.json(
          '/api/v1/products/product-stool/purchases',
          'POST',
          payload,
        ),
      ),
    ).toEqual(first);
    expect(
      (await body(await guest.request('/api/v1/products/product-stool'))).data
        .stock,
    ).toBe(1);
  });

  it("allows Laravel's empty prohibited values while fixing the Minecraft purchase source", async () => {
    const payload = {
      productId: 'product-stool',
      buyerId: 'user-buyer',
      requestId: 'empty-source',
    };
    const first = await body(
      await guest.json('/api/v1/minecraft/purchases', 'POST', {
        ...payload,
        source: {},
      }),
      201,
    );
    expect(first.data.source).toBe('minecraft');
    for (const source of [null, '', []]) {
      expect(
        await body(
          await guest.json('/api/v1/minecraft/purchases', 'POST', {
            ...payload,
            source,
          }),
        ),
      ).toEqual(first);
    }
  });

  it('preserves the Fabric health endpoint and credentialed CORS preflight', async () => {
    const hello = await guest.request('/api/hello');
    expect(hello.status).toBe(200);
    expect(hello.headers.get('Content-Type')?.toLowerCase()).toBe(
      'text/plain; charset=utf-8',
    );
    expect(await hello.text()).toBe('MineTenant API is running.');
    const preflight = await guest.request('/api/v1/products', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type,X-XSRF-TOKEN',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:5173',
    );
    expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true',
    );
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain(
      'POST',
    );
  });

  it('returns the same public inventory, order, numeric values, fields and UTC dates', async () => {
    const { data } = await body(await guest.request('/api/v1/products'));
    expect(data.map((product: { id: string }) => product.id)).toEqual([
      'product-hoodie',
      'product-stool',
      'product-notebook',
      'product-pendant',
      'product-toolbag',
      'product-lamp',
    ]);
    const detail = await body(
      await guest.request('/api/v1/products/product-stool'),
    );
    expect(detail.data).toEqual({
      id: 'product-stool',
      storeId: 'store-mine',
      sellerId: 'user-seller',
      name: '森の木製スツール',
      description:
        '天然木の表情を残して仕上げた小さなスツールです。椅子としても飾り台としても使えます。',
      price: 4200,
      stock: 2,
      category: 'interior',
      theme: 'forest',
      emoji: '🪵',
      createdAt: '2026-07-17T04:30:00.000000Z',
    });
    expect(
      await body(await guest.request('/api/v1/minecraft/catalog')),
    ).toEqual({ data });
    expect(
      data.find((product: { id: string }) => product.id === 'product-notebook')
        .stock,
    ).toBe(0);
    await expectStatus(await guest.request('/api/v1/products/missing'), 404);
  });

  it('combines trimmed name/description keyword search with store filtering', async () => {
    const checks = [
      [{ keyword: '  スツール  ' }, ['product-stool']],
      [{ keyword: '暖色' }, ['product-lamp']],
      [{ keyword: '森', storeId: 'store-mine' }, ['product-stool']],
      [{ keyword: '森', storeId: 'store-yamada' }, ['product-lamp']],
      [
        { storeId: 'store-yamada' },
        ['product-pendant', 'product-toolbag', 'product-lamp'],
      ],
      [{ keyword: 'not-present' }, []],
    ] as const;
    for (const [query, expected] of checks) {
      const { data } = await body(
        await guest.request(`/api/v1/products?${new URLSearchParams(query)}`),
      );
      expect(data.map((product: { id: string }) => product.id)).toEqual(
        expected,
      );
    }
    for (const keyword of ['', '   ']) {
      const { data } = await body(
        await guest.request(
          `/api/v1/products?${new URLSearchParams({ keyword })}`,
        ),
      );
      expect(data).toHaveLength(6);
      expect(data[0].id).toBe('product-hoodie');
    }
  });

  it('treats SQL wildcards, the escape character and quotes as literal search text', async () => {
    for (const [name, keyword] of [
      ['100% cotton', '%'],
      ['tool_bag', '_'],
      ['hello!', '!'],
      ["O'Reilly book", "O'Reilly"],
    ]) {
      const created = await body(
        await seller.json('/api/v1/products', 'POST', {
          ...productPayload,
          name,
        }),
        201,
      );
      const found = await body(
        await guest.request(
          `/api/v1/products?${new URLSearchParams({ keyword: keyword! })}`,
        ),
      );
      expect(found.data.map((product: { id: string }) => product.id)).toEqual([
        created.data.id,
      ]);
    }
  });

  it('validates search query scalar types, Unicode length and store existence', async () => {
    for (const [query, field] of [
      [`keyword=${encodeURIComponent('あ'.repeat(121))}`, 'keyword'],
      ['keyword[]=stool', 'keyword'],
      ['storeId[]=store-mine', 'storeId'],
      ['storeId=missing', 'storeId'],
    ]) {
      const result = await body(
        await guest.request(`/api/v1/products?${query}`),
        422,
      );
      expect(result.errors).toHaveProperty(field!);
    }
    await expectStatus(
      await guest.request(
        `/api/v1/products?keyword=${encodeURIComponent('あ'.repeat(120))}`,
      ),
      200,
    );
  });

  it('creates products under the signed-in user and their store, including buyer-role users', async () => {
    const created = await body(
      await buyer.json('/api/v1/products', 'POST', productPayload),
      201,
    );
    expect(created.data).toMatchObject({
      ...productPayload,
      sellerId: 'user-buyer',
      storeId: 'store-yamada',
    });
    expect(created.data.id).toEqual(expect.any(String));
    expect(
      await body(await guest.request(`/api/v1/products/${created.data.id}`)),
    ).toEqual(created);
    const listed = await body(await guest.request('/api/v1/products'));
    expect(listed.data[0].id).toBe(created.data.id);
  });

  it('accepts explicit owner IDs and Laravel-compatible integer strings', async () => {
    const result = await body(
      await seller.json('/api/v1/products', 'POST', {
        ...productPayload,
        storeId: 'store-mine',
        sellerId: 'user-seller',
        price: '2500',
        stock: '3',
      }),
      201,
    );
    expect(result.data).toMatchObject({
      price: 2500,
      stock: 3,
      storeId: 'store-mine',
      sellerId: 'user-seller',
    });
  });

  it('rejects invalid listing fields together without storing anything', async () => {
    const result = await body(
      await seller.json('/api/v1/products', 'POST', {
        storeId: '',
        sellerId: '',
        name: '',
        description: '',
        price: 0,
        stock: -1,
        category: 'unknown',
        theme: 'unknown',
        emoji: '',
      }),
      422,
    );
    expect(Object.keys(result.errors).sort()).toEqual(
      [
        'storeId',
        'sellerId',
        'name',
        'description',
        'price',
        'stock',
        'category',
        'theme',
        'emoji',
      ].sort(),
    );
    expect(
      (await body(await guest.request('/api/v1/products'))).data,
    ).toHaveLength(6);
  });

  it('enforces listing field maximums and uses Unicode character counts', async () => {
    const valid = {
      ...productPayload,
      name: 'あ'.repeat(120),
      description: '文'.repeat(2000),
      emoji: '🧰'.repeat(16),
      price: 99999999,
      stock: 99999,
    };
    await expectStatus(
      await seller.json('/api/v1/products', 'POST', valid),
      201,
    );
    const invalid = {
      ...valid,
      name: 'あ'.repeat(121),
      description: '文'.repeat(2001),
      emoji: '🧰'.repeat(17),
      price: 100000000,
      stock: 100000,
    };
    const result = await body(
      await seller.json('/api/v1/products', 'POST', invalid),
      422,
    );
    for (const field of ['name', 'description', 'emoji', 'price', 'stock'])
      expect(result.errors).toHaveProperty(field);
  });

  it('rejects another seller identity or another store even when omitted identity is valid', async () => {
    const forged = await body(
      await buyer.json('/api/v1/products', 'POST', {
        ...productPayload,
        sellerId: 'user-seller',
        storeId: 'store-mine',
      }),
      422,
    );
    expect(forged.errors).toHaveProperty('sellerId');
    await expectStatus(
      await buyer.json('/api/v1/products', 'POST', {
        ...productPayload,
        storeId: 'store-mine',
      }),
      422,
    );
    expect(
      (await body(await guest.request('/api/v1/products'))).data,
    ).toHaveLength(6);
  });

  it('requires login on every private web route with JSON responses', async () => {
    await expectStatus(await guest.request('/api/v1/auth/csrf-cookie'), 204);
    for (const path of [
      '/auth/me',
      '/users',
      '/transactions',
      '/transactions/transaction-demo',
      '/stores/store-mine/dashboard',
    ]) {
      const response = await guest.request(`/api/v1${path}`);
      await expectStatus(response, 401);
      expect(response.headers.get('Content-Type')).toContain(
        'application/json',
      );
    }
    for (const path of [
      '/products',
      '/purchases',
      '/products/product-stool/purchases',
      '/auth/logout',
    ]) {
      await expectStatus(await guest.json(`/api/v1${path}`, 'POST', {}), 401);
    }
    await expectStatus(
      await guest.json('/api/v1/products/product-stool', 'DELETE'),
      401,
    );
  });

  it('allows only the seller to delete products with no transaction history', async () => {
    await expectStatus(
      await buyer.json('/api/v1/products/product-hoodie', 'DELETE'),
      403,
    );
    const deleted = await seller.json(
      '/api/v1/products/product-hoodie',
      'DELETE',
    );
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    await expectStatus(
      await guest.request('/api/v1/products/product-hoodie'),
      404,
    );
    expect(
      (await body(await guest.request('/api/v1/products'))).data,
    ).toHaveLength(5);
    await expectStatus(
      await seller.json('/api/v1/products/missing', 'DELETE'),
      404,
    );
  });

  it('preserves a historically purchased product, its transaction and store on deletion conflict', async () => {
    const result = await body(
      await seller.json('/api/v1/products/product-stool', 'DELETE'),
      409,
    );
    expect(result.message).toBe(
      'Products with transaction history cannot be deleted.',
    );
    expect(
      (await body(await guest.request('/api/v1/products/product-stool'))).data
        .stock,
    ).toBe(2);
    expect(
      (await body(await guest.request('/api/v1/stores/store-mine'))).data
        .points,
    ).toBe(420);
    expect(
      (await body(await buyer.request('/api/v1/transactions'))).data,
    ).toHaveLength(1);
    expect(
      (await body(await buyer.request('/api/v1/transactions/transaction-demo')))
        .data,
    ).toMatchObject({
      productId: 'product-stool',
      buyerId: 'user-buyer',
      sellerId: 'user-seller',
      amount: 4200,
    });
  });

  it('purchases with shared stock, 100 store points, fixed price and paid status', async () => {
    const result = await body(
      await buyer.json('/api/v1/products/product-stool/purchases', 'POST', {
        buyerId: 'user-buyer',
        source: 'web',
        requestId: 'web-purchase',
      }),
      201,
    );
    expect(result.data).toMatchObject({
      productId: 'product-stool',
      buyerId: 'user-buyer',
      sellerId: 'user-seller',
      source: 'web',
      amount: 4200,
      status: 'paid',
    });
    expect(Object.keys(result.data).sort()).toEqual(
      [
        'id',
        'productId',
        'buyerId',
        'sellerId',
        'source',
        'amount',
        'status',
        'createdAt',
      ].sort(),
    );
    expect(
      (await body(await guest.request('/api/v1/products/product-stool'))).data
        .stock,
    ).toBe(1);
    expect(
      (await body(await guest.request('/api/v1/stores/store-mine'))).data,
    ).toMatchObject({ points: 520, level: 3 });
  });

  it('uses session defaults and deduplicates retries across both web purchase URLs', async () => {
    const payload = {
      productId: 'product-stool',
      requestId: 'web-alias-request',
    };
    const first = await body(
      await buyer.json('/api/v1/purchases', 'POST', payload),
      201,
    );
    const retry = await body(
      await buyer.json('/api/v1/purchases', 'POST', payload),
    );
    const alternate = await body(
      await buyer.json('/api/v1/products/product-stool/purchases', 'POST', {
        requestId: payload.requestId,
      }),
    );
    expect(retry).toEqual(first);
    expect(alternate).toEqual(first);
    expect(first.data).toMatchObject({
      buyerId: 'user-buyer',
      source: 'web',
    });
    expect(
      (await body(await guest.request('/api/v1/products/product-stool'))).data
        .stock,
    ).toBe(1);
    expect(
      (await body(await guest.request('/api/v1/stores/store-mine'))).data
        .points,
    ).toBe(520);
    expect(
      (await body(await buyer.request('/api/v1/transactions'))).data,
    ).toHaveLength(2);
  });

  it('rejects requestId reuse for a different product, buyer or source without stock changes', async () => {
    await expectStatus(
      await buyer.json('/api/v1/purchases', 'POST', {
        productId: 'product-stool',
        requestId: 'shared-id',
      }),
      201,
    );
    const requests = [
      buyer.json('/api/v1/purchases', 'POST', {
        productId: 'product-hoodie',
        requestId: 'shared-id',
      }),
      guest.json('/api/v1/minecraft/purchases', 'POST', {
        productId: 'product-stool',
        buyerId: 'user-buyer',
        requestId: 'shared-id',
      }),
      guest.json('/api/v1/minecraft/purchases', 'POST', {
        productId: 'product-stool',
        buyerId: 'user-seller',
        requestId: 'shared-id',
      }),
    ];
    for (const response of await Promise.all(requests))
      expect((await body(response, 409)).code).toBe('REQUEST_ID_CONFLICT');
    expect(
      (await body(await guest.request('/api/v1/products/product-hoodie'))).data
        .stock,
    ).toBe(3);
    expect(
      (await body(await guest.request('/api/v1/stores/store-mine'))).data
        .points,
    ).toBe(520);
  });

  it('rejects self-purchase and sold-out items without inventory or growth changes', async () => {
    const self = await body(
      await seller.json('/api/v1/purchases', 'POST', {
        productId: 'product-stool',
        requestId: 'self',
      }),
      422,
    );
    expect(self.code).toBe('SELF_PURCHASE');
    expect(self.errors).toHaveProperty('buyerId');
    expect(
      (
        await body(
          await buyer.json('/api/v1/purchases', 'POST', {
            productId: 'product-notebook',
            requestId: 'sold-out',
          }),
          409,
        )
      ).code,
    ).toBe('OUT_OF_STOCK');
    expect(
      (await body(await guest.request('/api/v1/products/product-stool'))).data
        .stock,
    ).toBe(2);
    expect(
      (await body(await guest.request('/api/v1/products/product-notebook')))
        .data.stock,
    ).toBe(0);
    expect(
      (await body(await guest.request('/api/v1/stores/store-mine'))).data
        .points,
    ).toBe(420);
  });

  it('validates purchase aliases, identities, source and request IDs', async () => {
    const empty = await body(
      await buyer.json('/api/v1/purchases', 'POST', {}),
      422,
    );
    expect(empty.errors).toHaveProperty('productId');
    expect(empty.errors).toHaveProperty('requestId');
    const forged = await body(
      await buyer.json('/api/v1/purchases', 'POST', {
        productId: 'product-stool',
        requestId: 'forged',
        buyerId: 'user-seller',
        source: 'minecraft',
      }),
      422,
    );
    expect(forged.errors).toHaveProperty('buyerId');
    expect(forged.errors).toHaveProperty('source');
    const missing = await body(
      await buyer.json('/api/v1/purchases', 'POST', {
        productId: 'missing',
        requestId: 'missing',
      }),
      422,
    );
    expect(missing.errors).toHaveProperty('productId');
    const mismatch = await body(
      await buyer.json('/api/v1/products/product-stool/purchases', 'POST', {
        productId: 'product-hoodie',
        requestId: 'mismatch',
      }),
      422,
    );
    expect(mismatch.errors).toHaveProperty('productId');
    const long = await body(
      await buyer.json('/api/v1/purchases', 'POST', {
        productId: 'product-stool',
        requestId: 'あ'.repeat(101),
      }),
      422,
    );
    expect(long.errors).toHaveProperty('requestId');
    await expectStatus(
      await buyer.json('/api/v1/products/missing/purchases', 'POST', {
        requestId: 'missing-url',
      }),
      404,
    );
  });

  it('keeps Minecraft purchases unauthenticated, source-fixed, idempotent and shared with web', async () => {
    const payload = {
      productId: 'product-stool',
      buyerId: 'user-buyer',
      requestId: 'minecraft-purchase',
    };
    const first = await body(
      await guest.json('/api/v1/minecraft/purchases', 'POST', payload),
      201,
    );
    expect(first.data).toMatchObject({
      source: 'minecraft',
      status: 'paid',
    });
    expect(
      await body(
        await guest.json('/api/v1/minecraft/purchases', 'POST', payload),
      ),
    ).toEqual(first);
    expect(
      (await body(await guest.request('/api/v1/products/product-stool'))).data
        .stock,
    ).toBe(1);
    expect(
      (await body(await guest.request('/api/v1/stores/store-mine'))).data,
    ).toMatchObject({ points: 520, level: 3 });
    const wrongSource = await body(
      await guest.json('/api/v1/minecraft/purchases', 'POST', {
        ...payload,
        source: 'web',
      }),
      422,
    );
    expect(wrongSource.errors).toHaveProperty('source');
    const invalid = await body(
      await guest.json('/api/v1/minecraft/purchases', 'POST', {
        productId: 'missing',
        buyerId: 'missing',
        requestId: '',
      }),
      422,
    );
    for (const field of ['productId', 'buyerId', 'requestId'])
      expect(invalid.errors).toHaveProperty(field);
  });

  it('increments growth across level thresholds and caps progress at level five', async () => {
    await expectStatus(
      await seller.json('/api/v1/purchases', 'POST', {
        productId: 'product-toolbag',
        requestId: 'level-two',
      }),
      201,
    );
    expect(
      (await body(await guest.request('/api/v1/stores/store-yamada'))).data,
    ).toMatchObject({ points: 140, level: 2 });
    expect(
      (
        await body(
          await seller.json('/api/v1/purchases', 'POST', {
            productId: 'product-toolbag',
            requestId: 'after-sold-out',
          }),
          409,
        )
      ).code,
    ).toBe('OUT_OF_STOCK');
    await test.db.execute(
      "UPDATE stores SET points = 950, level = 4 WHERE id = 'store-mine'",
    );
    await expectStatus(
      await buyer.json('/api/v1/purchases', 'POST', {
        productId: 'product-stool',
        requestId: 'level-five',
      }),
      201,
    );
    const dashboard = await body(
      await seller.request('/api/v1/stores/store-mine/dashboard'),
    );
    expect(dashboard.data.store).toMatchObject({ points: 1050, level: 5 });
    expect(dashboard.data.stats).toMatchObject({
      nextLevelPoints: 0,
      levelProgressPercent: 100,
    });
  });

  it('returns public store data and owner-only dashboard with exact legacy aggregates', async () => {
    const store = await body(await guest.request('/api/v1/stores/store-mine'));
    expect(store.data).toEqual({
      id: 'store-mine',
      ownerId: 'user-seller',
      name: 'BLUE ORE STUDIO',
      description: '青い鉱石を目印に、暮らしの道具と出会う店。',
      level: 3,
      points: 420,
      syncStatus: 'connected',
    });
    const dashboard = await body(
      await seller.request('/api/v1/stores/store-mine/dashboard'),
    );
    expect(dashboard.data.store).toEqual(store.data);
    expect(dashboard.data.products).toHaveLength(3);
    expect(dashboard.data.products[0].id).toBe('product-hoodie');
    expect(dashboard.data.stats).toEqual({
      productCount: 3,
      availableProductCount: 2,
      soldOutProductCount: 1,
      totalStock: 5,
      salesCount: 1,
      salesAmount: 4200,
      webSalesCount: 0,
      minecraftSalesCount: 1,
      nextLevelPoints: 180,
      levelProgressPercent: 40,
    });
    expect(dashboard.data.recentTransactions).toHaveLength(1);
    expect(dashboard.data.recentTransactions[0].id).toBe('transaction-demo');
    await expectStatus(
      await buyer.request('/api/v1/stores/store-mine/dashboard'),
      403,
    );
    await expectStatus(
      await buyer.request('/api/v1/stores/store-yamada/dashboard'),
      200,
    );
    await expectStatus(await guest.request('/api/v1/stores/missing'), 404);
  });

  it('limits recent transactions to five while counting all historical statuses in sales totals', async () => {
    for (let index = 0; index < 6; index++) {
      await test.db.execute(
        'INSERT INTO purchase_transactions (id, request_id, product_id, buyer_id, seller_id, source, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          `history-${index}`,
          `history-request-${index}`,
          'product-stool',
          'user-buyer',
          'user-seller',
          'web',
          1000,
          'paid',
          `2026-08-0${index + 1} 00:00:00`,
          `2026-08-0${index + 1} 00:00:00`,
        ],
      );
    }
    const { data } = await body(
      await seller.request('/api/v1/stores/store-mine/dashboard'),
    );
    expect(data.stats).toMatchObject({
      salesCount: 7,
      salesAmount: 10200,
      webSalesCount: 6,
      minecraftSalesCount: 1,
    });
    expect(
      data.recentTransactions.map(
        (transaction: { id: string }) => transaction.id,
      ),
    ).toEqual([
      'history-5',
      'history-4',
      'history-3',
      'history-2',
      'history-1',
    ]);
  });

  it('scopes transactions to the current buyer or seller and protects unrelated detail', async () => {
    for (const [client, userId] of [
      [buyer, 'user-buyer'],
      [seller, 'user-seller'],
    ] as const) {
      const result = await body(
        await client.request(`/api/v1/transactions?userId=${userId}`),
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        id: 'transaction-demo',
        source: 'minecraft',
        status: 'shipping',
        createdAt: '2026-07-21T08:30:00.000000Z',
      });
      expect(
        (
          await body(
            await client.request('/api/v1/transactions/transaction-demo'),
          )
        ).data,
      ).toEqual(result.data[0]);
    }
    expect(
      (
        await body(
          await buyer.request('/api/v1/transactions?userId=user-seller'),
          422,
        )
      ).errors,
    ).toHaveProperty('userId');
    expect(
      (
        await body(
          await buyer.request('/api/v1/transactions?userId=missing'),
          422,
        )
      ).errors,
    ).toHaveProperty('userId');
    await expectStatus(await guest.request('/api/v1/auth/csrf-cookie'), 204);
    await expectStatus(
      await guest.json('/api/v1/auth/register', 'POST', {
        name: 'Other User',
        email: 'other@example.test',
        password: 'password-123',
      }),
      201,
    );
    expect(
      (await body(await guest.request('/api/v1/transactions'))).data,
    ).toEqual([]);
    await expectStatus(
      await guest.request('/api/v1/transactions/transaction-demo'),
      403,
    );
    await expectStatus(
      await guest.request('/api/v1/transactions/missing'),
      404,
    );
  });

  it('exposes only public user fields and includes their owned stores', async () => {
    const { data } = await body(await buyer.request('/api/v1/users'));
    expect(data).toHaveLength(2);
    expect(data).toEqual(
      expect.arrayContaining([
        {
          id: 'user-buyer',
          name: '山田 みどり',
          role: 'buyer',
          roleLabel: '購入者デモ',
          avatarInitial: '山',
          storeId: 'store-yamada',
        },
        {
          id: 'user-seller',
          name: '青鉱舎 店長',
          role: 'seller',
          roleLabel: '出品者デモ',
          avatarInitial: 'M',
          storeId: 'store-mine',
        },
      ]),
    );
  });
});
