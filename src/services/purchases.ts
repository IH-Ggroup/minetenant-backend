import { randomUUID } from 'node:crypto';
import type { Database, SqlExecutor } from '../db.js';
import {
  outOfStock,
  productNotFound,
  purchaseStoreNotReady,
  requestIdConflict,
  selfPurchase,
} from '../domain/errors.js';
import type {
  ProductRow,
  PurchaseInput,
  StoreRow,
  TransactionRow,
} from '../domain/types.js';
import { levelForPoints } from './store-growth.js';

export const PURCHASE_BUYER_POINTS = 50;
export const PURCHASE_SELLER_POINTS = 100;

async function lockPurchaseStores(
  db: SqlExecutor,
  product: ProductRow,
  buyerId: string,
): Promise<{ buyer: StoreRow; seller: StoreRow; locked: StoreRow[] }> {
  const [buyerReference] = await db.query<{ store_id: string }>(
    'SELECT store_id FROM stores WHERE user_id = ?',
    [buyerId],
  );
  if (!buyerReference) purchaseStoreNotReady();

  const locked: StoreRow[] = [];
  // Every purchase uses the same order even when buyer and seller are reversed
  // in another transaction, preventing a two-Store lock cycle.
  const storeIds = [buyerReference.store_id, product.store_id].sort();
  for (const storeId of storeIds) {
    const [store] = await db.query<StoreRow>(
      'SELECT * FROM stores WHERE store_id = ? FOR UPDATE',
      [storeId],
    );
    if (!store) purchaseStoreNotReady();
    locked.push(store);
  }

  const buyer = locked.find(
    (store) =>
      store.store_id === buyerReference.store_id && store.user_id === buyerId,
  );
  const seller = locked.find(
    (store) =>
      store.store_id === product.store_id && store.user_id === product.user_id,
  );
  if (!buyer || !seller || buyer.store_id === seller.store_id)
    purchaseStoreNotReady();
  return { buyer, seller, locked };
}

async function addStorePoints(
  db: SqlExecutor,
  store: StoreRow,
  awardedPoints: number,
): Promise<void> {
  const points = Number(store.points) + awardedPoints;
  const result = await db.execute(
    `UPDATE stores
        SET points = ?, level = ?, updated_at = UTC_TIMESTAMP(6)
      WHERE store_id = ?`,
    [points, levelForPoints(points), store.store_id],
  );
  if (result.affectedRows !== 1)
    throw new Error('Purchase growth did not update exactly one store.');
}

function ensureSamePurchase(
  transaction: TransactionRow,
  input: PurchaseInput,
): void {
  if (
    transaction.product_id !== input.productId ||
    transaction.buyer_user_id !== input.buyerId ||
    transaction.source !== input.source
  ) {
    requestIdConflict();
  }
}

async function findRequest(
  db: SqlExecutor,
  requestId: string,
  lock = false,
): Promise<TransactionRow | undefined> {
  const [transaction] = await db.query<TransactionRow>(
    `SELECT * FROM purchase_transactions WHERE request_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [requestId],
  );
  return transaction;
}

async function withCanonicalProductId(
  db: SqlExecutor,
  input: PurchaseInput,
): Promise<PurchaseInput> {
  const [product] = await db.query<{ product_id: string }>(
    'SELECT product_id FROM products WHERE product_id = ?',
    [input.productId],
  );
  return product ? { ...input, productId: product.product_id } : input;
}

/** Replay a saved purchase without creating a new transaction. */
export async function replayPurchase(
  db: SqlExecutor,
  input: PurchaseInput,
): Promise<TransactionRow | undefined> {
  const transaction = await findRequest(db, input.requestId);
  if (transaction)
    ensureSamePurchase(transaction, await withCanonicalProductId(db, input));
  return transaction;
}

export async function purchase(
  db: Database,
  input: PurchaseInput,
): Promise<{ transaction: TransactionRow; created: boolean }> {
  try {
    return await db.transaction(async (tx) => {
      const existing = await findRequest(tx, input.requestId, true);
      if (existing) {
        ensureSamePurchase(existing, await withCanonicalProductId(tx, input));
        return { transaction: existing, created: false };
      }

      const [product] = await tx.query<ProductRow>(
        'SELECT * FROM products WHERE product_id = ? FOR UPDATE',
        [input.productId],
      );
      if (!product || product.deleted_at !== null) productNotFound();
      const canonicalInput = { ...input, productId: product.product_id };

      // A competing retry may have committed while this request waited for the
      // product lock. Replay it before deciding the last item is sold out.
      const committed = await findRequest(tx, input.requestId, true);
      if (committed) {
        ensureSamePurchase(committed, canonicalInput);
        return { transaction: committed, created: false };
      }

      if (product.user_id === input.buyerId) selfPurchase();
      if (product.status !== 'available') outOfStock();

      const stores = await lockPurchaseStores(tx, product, input.buyerId);

      await tx.execute(
        `UPDATE products
          SET status = 'sold', stock = 0, updated_at = UTC_TIMESTAMP()
          WHERE product_id = ?`,
        [product.product_id],
      );
      const transactionId = randomUUID();
      await tx.execute(
        `INSERT INTO purchase_transactions
          (transaction_id, request_id, product_id, buyer_user_id, seller_user_id, source, amount, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [
          transactionId,
          input.requestId,
          product.product_id,
          input.buyerId,
          product.user_id,
          input.source,
          product.price,
        ],
      );
      for (const store of stores.locked) {
        await addStorePoints(
          tx,
          store,
          store.store_id === stores.buyer.store_id
            ? PURCHASE_BUYER_POINTS
            : PURCHASE_SELLER_POINTS,
        );
      }
      const [transaction] = await tx.query<TransactionRow>(
        'SELECT * FROM purchase_transactions WHERE transaction_id = ?',
        [transactionId],
      );
      if (!transaction) throw new Error('Created transaction was not found.');
      return { transaction, created: true };
    });
  } catch (error) {
    // Distinct products can race on the global request_id unique index. The
    // losing transaction has rolled back its stock/growth updates at this point.
    const sqlError = error as { errno?: number; message?: string };
    if (
      sqlError.errno !== 1062 ||
      !sqlError.message?.toLowerCase().includes('request_id')
    )
      throw error;
    const existing = await replayPurchase(db, input);
    if (!existing) throw error;
    return { transaction: existing, created: false };
  }
}
