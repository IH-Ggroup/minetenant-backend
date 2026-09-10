import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { notFound } from '../domain/errors.js';
import {
  serializeProduct,
  serializeTransaction,
} from '../domain/serializers.js';
import type { ProductRow } from '../domain/types.js';
import { parseBody, Validator } from '../domain/validation.js';
import { purchase } from '../services/purchases.js';
import type { AppEnv } from '../types.js';

export function createPurchaseRoutes(
  db: Database,
  config: AppConfig,
  requireAuth: MiddlewareHandler<AppEnv>,
) {
  const routes = new Hono<AppEnv>();

  const webPurchase = async (c: Context<AppEnv>, routeProductId?: string) => {
    if (routeProductId !== undefined) {
      const [product] = await db.query<{ id: string }>(
        'SELECT id FROM products WHERE id = ?',
        [routeProductId],
      );
      if (!product) notFound();
      routeProductId = product.id;
    }
    const userId = c.get('user')!.id;
    const data = await parseBody(c.req.raw);
    if (!Object.hasOwn(data, 'buyerId')) data.buyerId = userId;
    if (!Object.hasOwn(data, 'source')) data.source = 'web';
    const validator = new Validator(data);
    const productId = validator.string('productId', {
      required: routeProductId === undefined,
      ...(routeProductId === undefined ? {} : { in: [routeProductId] }),
    });
    validator.string('buyerId', {
      required: true,
      in: [userId],
      messages: { required: '購入者を指定してください。' },
    });
    validator.string('source', {
      required: true,
      in: ['web'],
      messages: {
        required: '購入元を指定してください。',
        in: 'Web購入では購入元にwebを指定してください。',
      },
    });
    const requestId = validator.string('requestId', {
      required: true,
      max: 100,
      messages: {
        required: '購入リクエストIDを指定してください。',
        max: '購入リクエストIDは100文字以内で指定してください。',
      },
    });
    if (productId !== undefined) {
      const [product] = await db.query<{ id: string }>(
        'SELECT id FROM products WHERE id = ?',
        [productId],
      );
      if (!product)
        validator.add('productId', 'The selected product id is invalid.');
    }
    validator.throwIfInvalid();
    const result = await purchase(
      db,
      {
        productId: routeProductId ?? productId!,
        buyerId: userId,
        source: 'web',
        requestId: requestId!,
      },
      config.salePoints,
    );
    return c.json(
      { data: serializeTransaction(result.transaction) },
      result.created ? 201 : 200,
    );
  };

  routes.post('/purchases', requireAuth, (c) => webPurchase(c));
  routes.post('/products/:product/purchases', requireAuth, (c) =>
    webPurchase(c, c.req.param('product')),
  );

  routes.get('/minecraft/catalog', async (c) => {
    const products = await db.query<ProductRow>(
      'SELECT * FROM products ORDER BY created_at DESC',
    );
    return c.json({ data: products.map(serializeProduct) });
  });

  routes.post('/minecraft/purchases', async (c) => {
    const validator = new Validator(await parseBody(c.req.raw));
    const productId = validator.string('productId', {
      required: true,
      messages: { required: '購入する商品を指定してください。' },
    });
    const buyerId = validator.string('buyerId', {
      required: true,
      messages: { required: '購入者を指定してください。' },
    });
    const requestId = validator.string('requestId', {
      required: true,
      max: 100,
      messages: {
        required: '購入リクエストIDを指定してください。',
        max: '購入リクエストIDは100文字以内で指定してください。',
      },
    });
    validator.prohibited('source', 'Minecraft購入では購入元を指定できません。');
    if (productId !== undefined) {
      const [product] = await db.query<{ id: string }>(
        'SELECT id FROM products WHERE id = ?',
        [productId],
      );
      if (!product)
        validator.add('productId', '指定された商品が見つかりません。');
    }
    if (buyerId !== undefined) {
      const [buyer] = await db.query<{ id: string }>(
        'SELECT id FROM users WHERE id = ?',
        [buyerId],
      );
      if (!buyer)
        validator.add('buyerId', '指定された購入者が見つかりません。');
    }
    validator.throwIfInvalid();
    const result = await purchase(
      db,
      {
        productId: productId!,
        buyerId: buyerId!,
        requestId: requestId!,
        source: 'minecraft',
      },
      config.salePoints,
    );
    return c.json(
      { data: serializeTransaction(result.transaction) },
      result.created ? 201 : 200,
    );
  });

  return routes;
}
