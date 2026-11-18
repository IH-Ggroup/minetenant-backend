import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { purchaseResultNotFound } from '../domain/errors.js';
import {
  serializeProduct,
  serializeTransaction,
} from '../domain/serializers.js';
import { parseBody, Validator } from '../domain/validation.js';
import { listPublicProducts } from '../services/public-products.js';
import {
  findPurchaseResult,
  purchase,
  replayPurchase,
} from '../services/purchases.js';
import type { AppEnv } from '../types.js';

const purchaseRequestIdPattern = /^[A-Za-z0-9._:-]{1,100}$/;

function rejectUnexpectedFields(
  validator: Validator,
  data: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): void {
  for (const field of Object.keys(data)) {
    if (!allowedFields.has(field))
      validator.add(field, 'この項目は指定できません。');
  }
}

export function createPurchaseRoutes(
  db: Database,
  config: AppConfig,
  requireAuth: MiddlewareHandler<AppEnv>,
) {
  const routes = new Hono<AppEnv>();

  const webPurchase = async (c: Context<AppEnv>, routeProductId?: string) => {
    const userId = c.get('user')!.user_id;
    const data = await parseBody(c.req.raw, {
      preserveStrings: ['requestId'],
    });
    const validator = new Validator(data);
    const canonicalRoute = routeProductId !== undefined;
    rejectUnexpectedFields(
      validator,
      data,
      new Set(canonicalRoute ? ['requestId'] : ['productId', 'requestId']),
    );
    const bodyProductId = canonicalRoute
      ? undefined
      : validator.string('productId', {
          required: true,
          messages: { required: '購入する商品を指定してください。' },
        });
    const requestId = validator.string('requestId', {
      required: true,
      max: 255,
      messages: {
        required: '購入リクエストIDを指定してください。',
        max: '購入リクエストIDは255文字以内で指定してください。',
      },
    });
    validator.throwIfInvalid();

    const requestedProductId = routeProductId ?? bodyProductId!;
    const input = {
      productId: requestedProductId,
      buyerId: userId,
      source: 'web' as const,
      requestId: requestId!,
    };

    if (!purchaseRequestIdPattern.test(requestId!)) {
      const transaction = await replayPurchase(db, input);
      if (transaction)
        return c.json({ data: serializeTransaction(transaction) }, 200);
      validator.add(
        'requestId',
        '新しい購入リクエストIDは英数字と._:-のみを使い、100文字以内で指定してください。',
      );
      validator.throwIfInvalid();
    }

    const result = await purchase(db, input, config.salePoints);
    return c.json(
      { data: serializeTransaction(result.transaction) },
      result.created ? 201 : 200,
    );
  };

  routes.post('/purchases', requireAuth, (c) => webPurchase(c));
  routes.post('/products/:product/purchases', requireAuth, (c) =>
    webPurchase(c, c.req.param('product')),
  );
  routes.get('/purchases/requests/:requestId', requireAuth, async (c) => {
    const transaction = await findPurchaseResult(
      db,
      c.req.param('requestId'),
      c.get('user')!.user_id,
    );
    if (!transaction) purchaseResultNotFound();
    return c.json({ data: serializeTransaction(transaction) });
  });

  routes.get('/minecraft/catalog', async (c) => {
    const products = await listPublicProducts(db);
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
    if (buyerId !== undefined) {
      const [buyer] = await db.query<{ user_id: string }>(
        'SELECT user_id FROM users WHERE user_id = ?',
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
