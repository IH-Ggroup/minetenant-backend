import type { Database } from '../db.js';
import {
  serializeProduct,
  serializeStore,
  serializeTransaction,
} from '../domain/serializers.js';
import type { ProductRow, StoreRow, TransactionRow } from '../domain/types.js';
import { growthProgress } from './store-growth.js';

export async function getStoreDashboard(db: Database, store: StoreRow) {
  const [products, transactions] = await Promise.all([
    db.query<ProductRow>(
      `SELECT * FROM products
        WHERE store_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [store.store_id],
    ),
    db.query<TransactionRow>(
      'SELECT * FROM purchase_transactions WHERE seller_user_id = ? ORDER BY created_at DESC',
      [store.user_id],
    ),
  ]);
  const availableProductCount = products.filter(
    (product) => product.status === 'available',
  ).length;
  return {
    store: serializeStore(store),
    products: products.map(serializeProduct),
    stats: {
      productCount: products.length,
      availableProductCount,
      soldOutProductCount: products.filter(
        (product) => product.status === 'sold',
      ).length,
      totalStock: availableProductCount,
      salesCount: transactions.length,
      salesAmount: transactions.reduce(
        (total, transaction) => total + Number(transaction.amount),
        0,
      ),
      webSalesCount: transactions.filter(
        (transaction) => transaction.source === 'web',
      ).length,
      minecraftSalesCount: transactions.filter(
        (transaction) => transaction.source === 'minecraft',
      ).length,
      ...growthProgress(Number(store.level), Number(store.points)),
    },
    recentTransactions: transactions.slice(0, 5).map(serializeTransaction),
  };
}
