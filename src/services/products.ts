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
  Timestamp,
} from '../domain/types.js';
import { levelForPoints } from './store-growth.js';

export const LISTING_POINTS = 10;
export const DAILY_REWARDED_LISTING_LIMIT = 3;

interface ListingClockRow {
  created_at: Timestamp;
  day_start: Timestamp;
  next_day_start: Timestamp;
}

async function listingClock(db: SqlExecutor): Promise<ListingClockRow> {
  const [clock] = await db.query<ListingClockRow>(
    `SELECT listing_created_at AS created_at,
            TIMESTAMP(DATE(listing_created_at + INTERVAL 9 HOUR))
              - INTERVAL 9 HOUR AS day_start,
            TIMESTAMP(DATE(listing_created_at + INTERVAL 9 HOUR)
              + INTERVAL 1 DAY) - INTERVAL 9 HOUR AS next_day_start
       FROM (SELECT UTC_TIMESTAMP() AS listing_created_at) AS listing_clock`,
  );
  if (!clock?.created_at || !clock.day_start || !clock.next_day_start)
    throw new Error('The database did not return a listing clock.');
  return clock;
}

async function rewardedListingCount(
  db: SqlExecutor,
  storeId: string,
  clock: ListingClockRow,
): Promise<number> {
  const [row] = await db.query<{ listing_count: number | string }>(
    `SELECT COUNT(*) AS listing_count
       FROM products
      WHERE store_id = ?
        AND listing_request_id IS NOT NULL
        AND created_at >= ?
        AND created_at < ?`,
    [storeId, clock.day_start, clock.next_day_start],
  );
  const count = Number(row?.listing_count);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('The database returned an invalid listing count.');
  return count;
}

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
  // Keep this read outside the transaction. A missing-row lookup inside it
  // would create a repeatable-read snapshot before the Store lock, allowing a
  // queued concurrent listing to miss products committed while it waited.
  const observed = await findListingRequest(
    db,
    input.sellerId,
    input.requestId,
  );
  if (observed) {
    return db.transaction(async (tx) => {
      // Serialize a replay with purchase and deletion of this exact product so
      // the response reflects the mutation that actually committed first.
      const [locked] = await tx.query<ProductRow>(
        'SELECT * FROM products WHERE product_id = ? FOR UPDATE',
        [observed.product_id],
      );
      if (!locked) throw new Error('Listing request product was not found.');
      return replayListing(locked, fingerprint);
    });
  }

  return db.transaction(async (tx) => {
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

    const clock = await listingClock(tx);
    const rewardedToday = await rewardedListingCount(tx, store.store_id, clock);
    const productId = randomUUID();
    await tx.execute(
      `INSERT INTO products
        (product_id, store_id, user_id, name, description, price, stock,
         status, category, theme, emoji, listing_request_id,
         listing_request_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'available', ?, ?, ?, ?, ?, ?, ?)`,
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
        clock.created_at,
        clock.created_at,
      ],
    );
    if (rewardedToday < DAILY_REWARDED_LISTING_LIMIT) {
      const points = Number(store.points) + LISTING_POINTS;
      const result = await tx.execute(
        `UPDATE stores
            SET points = ?, level = ?, updated_at = ?
          WHERE store_id = ?`,
        [points, levelForPoints(points), clock.created_at, store.store_id],
      );
      if (result.affectedRows !== 1)
        throw new Error('Listing growth did not update exactly one store.');
    }
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
