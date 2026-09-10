import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { HttpError, notFound, ValidationError } from '../domain/errors.js';
import type {
  CreateProductInput,
  ProductRow,
  StoreRow,
} from '../domain/types.js';

export async function createProduct(
  db: Database,
  input: CreateProductInput,
): Promise<ProductRow> {
  const [store] = await db.query<StoreRow>(
    'SELECT * FROM stores WHERE id = ?',
    [input.storeId],
  );
  if (!store) notFound();
  if (store.owner_id !== input.sellerId) {
    throw new ValidationError({
      sellerId: ['出品者と店舗の所有者が一致しません。'],
    });
  }

  return db.transaction(async (tx) => {
    const id = randomUUID();
    await tx.execute(
      `INSERT INTO products
        (id, store_id, seller_id, name, description, price, stock, category, theme, emoji, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [
        id,
        input.storeId,
        input.sellerId,
        input.name,
        input.description,
        input.price,
        input.stock,
        input.category,
        input.theme,
        input.emoji,
      ],
    );
    const [product] = await tx.query<ProductRow>(
      'SELECT * FROM products WHERE id = ?',
      [id],
    );
    if (!product) throw new Error('Created product was not found.');
    return product;
  });
}

export async function deleteProduct(
  db: Database,
  productId: string,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Purchases take the same lock, so a sale cannot slip between the history
    // check and deletion.
    const [product] = await tx.query<ProductRow>(
      'SELECT * FROM products WHERE id = ? FOR UPDATE',
      [productId],
    );
    if (!product) notFound();
    if (product.seller_id !== userId)
      throw new HttpError(403, 'Only the seller can delete this product.');
    const [transaction] = await tx.query<{ id: string }>(
      'SELECT id FROM purchase_transactions WHERE product_id = ? LIMIT 1',
      [productId],
    );
    if (transaction)
      throw new HttpError(
        409,
        'Products with transaction history cannot be deleted.',
      );
    await tx.execute('DELETE FROM products WHERE id = ?', [productId]);
  });
}
