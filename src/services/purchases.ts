import { randomUUID } from 'node:crypto';
import type { Database, SqlExecutor } from '../db.js';
import {
  notFound,
  outOfStock,
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

function ensureSamePurchase(
  transaction: TransactionRow,
  input: PurchaseInput,
): void {
  if (
    transaction.product_id !== input.productId ||
    transaction.buyer_id !== input.buyerId ||
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

export async function purchase(
  db: Database,
  input: PurchaseInput,
  salePoints: number,
): Promise<{ transaction: TransactionRow; created: boolean }> {
  try {
    return await db.transaction(async (tx) => {
      const existing = await findRequest(tx, input.requestId, true);
      if (existing) {
        ensureSamePurchase(existing, input);
        return { transaction: existing, created: false };
      }

      const [product] = await tx.query<ProductRow>(
        'SELECT * FROM products WHERE id = ? FOR UPDATE',
        [input.productId],
      );
      if (!product) notFound();

      // A competing retry may have committed while this request waited for the
      // product lock. Replay it before deciding the last item is sold out.
      const committed = await findRequest(tx, input.requestId, true);
      if (committed) {
        ensureSamePurchase(committed, input);
        return { transaction: committed, created: false };
      }

      if (product.seller_id === input.buyerId) selfPurchase();
      if (Number(product.stock) < 1) outOfStock();

      const [store] = await tx.query<StoreRow>(
        'SELECT * FROM stores WHERE id = ? FOR UPDATE',
        [product.store_id],
      );
      if (!store) notFound();

      await tx.execute(
        'UPDATE products SET stock = stock - 1, updated_at = UTC_TIMESTAMP() WHERE id = ?',
        [product.id],
      );
      const id = randomUUID();
      await tx.execute(
        `INSERT INTO purchase_transactions
          (id, request_id, product_id, buyer_id, seller_id, source, amount, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [
          id,
          input.requestId,
          product.id,
          input.buyerId,
          product.seller_id,
          input.source,
          product.price,
        ],
      );
      const points = Number(store.points) + Math.max(0, Math.trunc(salePoints));
      await tx.execute(
        'UPDATE stores SET points = ?, level = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
        [points, levelForPoints(points), store.id],
      );
      const [transaction] = await tx.query<TransactionRow>(
        'SELECT * FROM purchase_transactions WHERE id = ?',
        [id],
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
    const existing = await findRequest(db, input.requestId);
    if (!existing) throw error;
    ensureSamePurchase(existing, input);
    return { transaction: existing, created: false };
  }
}
