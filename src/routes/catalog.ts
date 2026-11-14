import { Hono, type MiddlewareHandler } from 'hono';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { HttpError, notFound, productNotFound } from '../domain/errors.js';
import {
  serializeProduct,
  serializeStore,
  serializeTransaction,
} from '../domain/serializers.js';
import {
  productCategories,
  productThemes,
  type ProductCategory,
  type ProductTheme,
  type StoreRow,
  type TransactionRow,
} from '../domain/types.js';
import { parseBody, parseQuery, Validator } from '../domain/validation.js';
import { createProduct, deleteProduct } from '../services/products.js';
import {
  findPublicProduct,
  listPublicProducts,
} from '../services/public-products.js';
import { getStoreDashboard } from '../services/store-dashboard.js';
import type { AppEnv } from '../types.js';

export function createCatalogRoutes(
  db: Database,
  _config: AppConfig,
  requireAuth: MiddlewareHandler<AppEnv>,
) {
  const routes = new Hono<AppEnv>();

  routes.get('/products', async (c) => {
    const validator = new Validator(parseQuery(c.req.url));
    const storeId = validator.string('storeId');
    const keyword =
      validator.string('keyword', { nullable: true, max: 120 }) ?? '';
    if (storeId !== undefined) {
      const [store] = await db.query<{ store_id: string }>(
        'SELECT store_id FROM stores WHERE store_id = ?',
        [storeId],
      );
      if (!store) validator.add('storeId', 'The selected store id is invalid.');
    }
    validator.throwIfInvalid();

    const products = await listPublicProducts(db, { storeId, keyword });
    return c.json({ data: products.map(serializeProduct) });
  });

  routes.get('/products/:product', async (c) => {
    const product = await findPublicProduct(db, c.req.param('product'));
    if (!product) productNotFound();
    return c.json({ data: serializeProduct(product) });
  });

  routes.post('/products', requireAuth, async (c) => {
    const user = c.get('user')!;
    const data = await parseBody(c.req.raw, {
      preserveStrings: ['requestId'],
    });
    for (const field of ['name', 'description', 'category', 'theme', 'emoji']) {
      if (typeof data[field] === 'string')
        data[field] = data[field].normalize('NFC');
    }
    const validator = new Validator(data);
    const allowedFields = new Set([
      'requestId',
      'name',
      'description',
      'price',
      'category',
      'theme',
      'emoji',
    ]);
    for (const field of Object.keys(data)) {
      if (!allowedFields.has(field))
        validator.add(field, 'この項目は指定できません。');
    }
    const requestId = validator.string('requestId', {
      required: true,
      max: 100,
      messages: {
        required: '出品リクエストIDを指定してください。',
        max: '出品リクエストIDは100文字以内で指定してください。',
      },
    });
    if (requestId !== undefined && !/^[A-Za-z0-9._:-]{1,100}$/.test(requestId))
      validator.add('requestId', '出品リクエストIDの形式が正しくありません。');
    const name = validator.string('name', {
      required: true,
      max: 120,
      messages: { required: '商品名を入力してください。' },
    });
    const description = validator.string('description', {
      required: true,
      max: 2000,
      messages: { required: '商品説明を入力してください。' },
    });
    const price = validator.integer('price', {
      required: true,
      min: 1,
      max: 99_999_999,
      strictNumber: true,
      messages: {
        required: '価格を入力してください。',
        integer: '価格は整数で入力してください。',
        min: '価格は1円以上で入力してください。',
      },
    });
    const category = validator.string('category', {
      required: true,
      in: productCategories,
      messages: { required: 'カテゴリを選択してください。' },
    });
    const theme = validator.string('theme', {
      required: true,
      in: productThemes,
      messages: { required: '商品テーマを選択してください。' },
    });
    const emoji = validator.string('emoji', {
      required: true,
      max: 16,
      messages: { required: '商品を表す絵文字を指定してください。' },
    });
    validator.throwIfInvalid();
    const result = await createProduct(db, {
      requestId: requestId!,
      sellerId: user.user_id,
      name: name!,
      description: description!,
      price: price!,
      category: category as ProductCategory,
      theme: theme as ProductTheme,
      emoji: emoji!,
    });
    return c.json(
      { data: serializeProduct(result.product) },
      result.created ? 201 : 200,
    );
  });

  routes.delete('/products/:product', requireAuth, async (c) => {
    await deleteProduct(db, c.req.param('product'), c.get('user')!.user_id);
    return c.body(null, 204);
  });

  routes.get('/stores/:store', async (c) => {
    const [store] = await db.query<StoreRow>(
      'SELECT * FROM stores WHERE store_id = ?',
      [c.req.param('store')],
    );
    if (!store) notFound();
    return c.json({ data: serializeStore(store) });
  });

  routes.get('/stores/:store/dashboard', requireAuth, async (c) => {
    const [store] = await db.query<StoreRow>(
      'SELECT * FROM stores WHERE store_id = ?',
      [c.req.param('store')],
    );
    if (!store) notFound();
    if (store.user_id !== c.get('user')!.user_id)
      throw new HttpError(403, 'Forbidden');
    return c.json({ data: await getStoreDashboard(db, store) });
  });

  routes.get('/transactions', requireAuth, async (c) => {
    const userId = c.get('user')!.user_id;
    const validator = new Validator(parseQuery(c.req.url));
    validator.string('userId', { in: [userId] });
    validator.throwIfInvalid();
    const transactions = await db.query<TransactionRow>(
      'SELECT * FROM purchase_transactions WHERE buyer_user_id = ? OR seller_user_id = ? ORDER BY created_at DESC',
      [userId, userId],
    );
    return c.json({ data: transactions.map(serializeTransaction) });
  });

  routes.get('/transactions/:transaction', requireAuth, async (c) => {
    const [transaction] = await db.query<TransactionRow>(
      'SELECT * FROM purchase_transactions WHERE transaction_id = ?',
      [c.req.param('transaction')],
    );
    if (!transaction) notFound();
    const userId = c.get('user')!.user_id;
    if (
      transaction.buyer_user_id !== userId &&
      transaction.seller_user_id !== userId
    )
      throw new HttpError(403, 'Forbidden');
    return c.json({ data: serializeTransaction(transaction) });
  });

  return routes;
}
