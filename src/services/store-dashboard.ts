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
      'SELECT * FROM products WHERE store_id = ? ORDER BY created_at DESC',
      [store.id],
    ),
    db.query<TransactionRow>(
      'SELECT * FROM purchase_transactions WHERE seller_id = ? ORDER BY created_at DESC',
      [store.owner_id],
    ),
  ]);
  return {
    store: serializeStore(store),
    products: products.map(serializeProduct),
    stats: {
      productCount: products.length,
      availableProductCount: products.filter(
        (product) => Number(product.stock) > 0,
      ).length,
      soldOutProductCount: products.filter(
        (product) => Number(product.stock) === 0,
      ).length,
      totalStock: products.reduce(
        (total, product) => total + Number(product.stock),
        0,
      ),
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
