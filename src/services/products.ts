import { createHash, randomUUID } from 'node:crypto';
import type { Database, SqlExecutor } from '../db.js';
import {
  HttpError,
  listingRequestIdConflict,
  listingRequestRetired,
  productNotFound,
  userStoreNotReady,
} from '../domain/errors.js';
import type {
  CreateProductInput,
  ProductRow,
  StoreRow,
} from '../domain/types.js';

export function productListingFingerprint(
  input: Pick<
    CreateProductInput,
    'name' | 'description' | 'price' | 'category' | 'theme' | 'emoji'
  >,
): string {
  const serialized = JSON.stringify({
    name: input.name,
    description: input.description,
    price: input.price,
    category: input.category,
    theme: input.theme,
    emoji: input.emoji,
  });
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

async function findListingRequest(
  db: SqlExecutor,
  sellerId: string,
  requestId: string,
  lock = false,
): Promise<ProductRow | undefined> {
  const [product] = await db.query<ProductRow>(
    `SELECT * FROM products
      WHERE user_id = ? AND listing_request_id = ?
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [sellerId, requestId],
  );
  return product;
}

function replayListing(
  product: ProductRow,
  fingerprint: string,
): { product: ProductRow; created: false } {
  if (product.listing_request_fingerprint !== fingerprint)
    listingRequestIdConflict();
  if (product.deleted_at !== null) listingRequestRetired();
  return { product, created: false };
}

export async function createProduct(
  db: Database,
  input: CreateProductInput,
): Promise<{ product: ProductRow; created: boolean }> {
  const fingerprint = productListingFingerprint(input);
  return db.transaction(async (tx) => {
    const observed = await findListingRequest(
      tx,
      input.sellerId,
      input.requestId,
    );
    if (observed) {
      const [locked] = await tx.query<ProductRow>(
        'SELECT * FROM products WHERE product_id = ? FOR UPDATE',
        [observed.product_id],
      );
      if (!locked) throw new Error('Listing request product was not found.');
      return replayListing(locked, fingerprint);
    }

    const [store] = await tx.query<StoreRow>(
      'SELECT * FROM stores WHERE user_id = ? FOR UPDATE',
      [input.sellerId],
    );
    if (!store) userStoreNotReady();

    const committed = await findListingRequest(
      tx,
      input.sellerId,
      input.requestId,
      true,
    );
    if (committed) return replayListing(committed, fingerprint);

    const productId = randomUUID();
    await tx.execute(
      `INSERT INTO products
        (product_id, store_id, user_id, name, description, price, stock,
         status, category, theme, emoji, listing_request_id,
         listing_request_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'available', ?, ?, ?, ?, ?,
               UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [
        productId,
        store.store_id,
        input.sellerId,
        input.name,
        input.description,
        input.price,
        input.category,
        input.theme,
        input.emoji,
        input.requestId,
        fingerprint,
      ],
    );
    const [product] = await tx.query<ProductRow>(
      'SELECT * FROM products WHERE product_id = ?',
      [productId],
    );
    if (!product) throw new Error('Created product was not found.');
    return { product, created: true };
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
      'SELECT * FROM products WHERE product_id = ? FOR UPDATE',
      [productId],
    );
    if (!product || product.deleted_at !== null) productNotFound();
    if (product.user_id !== userId)
      throw new HttpError(403, 'Only the seller can delete this product.');
    if (product.status !== 'available')
      throw new HttpError(409, '売却済みの商品は削除できません。');
    const [transaction] = await tx.query<{ transaction_id: string }>(
      'SELECT transaction_id FROM purchase_transactions WHERE product_id = ? LIMIT 1',
      [productId],
    );
    if (transaction)
      throw new HttpError(409, '売却済みの商品は削除できません。');
    const result = await tx.execute(
      `UPDATE products
        SET deleted_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
        WHERE product_id = ?`,
      [productId],
    );
    if (result.affectedRows !== 1)
      throw new Error('Product soft delete did not update exactly one row.');
  });
}
