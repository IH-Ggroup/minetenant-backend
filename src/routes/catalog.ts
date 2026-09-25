import { Hono, type MiddlewareHandler } from 'hono';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { HttpError, notFound } from '../domain/errors.js';
import {
  serializeProduct,
  serializeStore,
  serializeTransaction,
  serializeUser,
} from '../domain/serializers.js';
import {
  productCategories,
  productThemes,
  type ProductCategory,
  type ProductRow,
  type ProductTheme,
  type StoreRow,
  type TransactionRow,
  type UserRow,
} from '../domain/types.js';
import { parseBody, parseQuery, Validator } from '../domain/validation.js';
import { createProduct, deleteProduct } from '../services/products.js';
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

    const where: string[] = [];
    const params: unknown[] = [];
    if (storeId) {
      where.push('store_id = ?');
      params.push(storeId);
    }
    if (keyword !== '') {
      const pattern = `%${keyword.replace(/[!%_]/g, (character) => `!${character}`)}%`;
      where.push("(name LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!')");
      params.push(pattern, pattern);
    }
    const products = await db.query<ProductRow>(
      `SELECT * FROM products${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`,
      params,
    );
    return c.json({ data: products.map(serializeProduct) });
  });

  routes.get('/products/:product', async (c) => {
    const [product] = await db.query<ProductRow>(
      'SELECT * FROM products WHERE product_id = ?',
      [c.req.param('product')],
    );
    if (!product) notFound();
    return c.json({ data: serializeProduct(product) });
  });

  routes.post('/products', requireAuth, async (c) => {
    const user = c.get('user')!;
    const data = await parseBody(c.req.raw);
    if (!Object.hasOwn(data, 'sellerId')) data.sellerId = user.user_id;
    if (!Object.hasOwn(data, 'storeId')) {
      const [store] = await db.query<{ store_id: string }>(
        'SELECT store_id FROM stores WHERE user_id = ?',
        [user.user_id],
      );
      data.storeId = store?.store_id ?? null;
    }
    const validator = new Validator(data);
    const storeId = validator.string('storeId', {
      required: true,
      messages: { required: '出品する店舗を指定してください。' },
    });
    const sellerId = validator.string('sellerId', {
      required: true,
      in: [user.user_id],
      messages: { required: '出品者を指定してください。' },
    });
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
      messages: {
        required: '価格を入力してください。',
        integer: '価格は整数で入力してください。',
        min: '価格は1円以上で入力してください。',
      },
    });
    const stock = validator.integer('stock', {
      required: true,
      min: 0,
      max: 99_999,
      messages: {
        required: '在庫数を入力してください。',
        integer: '在庫数は整数で入力してください。',
        min: '在庫数は0以上で入力してください。',
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
    if (storeId !== undefined) {
      const [store] = await db.query<{ store_id: string }>(
        'SELECT store_id FROM stores WHERE store_id = ?',
        [storeId],
      );
      if (!store) validator.add('storeId', '指定された店舗が見つかりません。');
    }
    validator.throwIfInvalid();
    const product = await createProduct(db, {
      storeId: storeId!,
      sellerId: sellerId!,
      name: name!,
      description: description!,
      price: price!,
      stock: stock!,
      category: category as ProductCategory,
      theme: theme as ProductTheme,
      emoji: emoji!,
    });
    return c.json({ data: serializeProduct(product) }, 201);
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

  routes.get('/users', requireAuth, async (c) => {
    const users = await db.query<UserRow>(
      'SELECT u.*, s.store_id AS store_id FROM users u LEFT JOIN stores s ON s.user_id = u.user_id ORDER BY u.name',
    );
    return c.json({ data: users.map(serializeUser) });
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
