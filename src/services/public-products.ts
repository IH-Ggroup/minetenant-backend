import type { Database } from '../db.js';
import type { ProductRow } from '../domain/types.js';

export interface PublicProductFilters {
  readonly storeId?: string;
  readonly keyword?: string;
}

const publicProductPredicates = [
  'deleted_at IS NULL',
  "BINARY status IN ('available', 'sold')",
] as const;

/** Find one product only when it is valid for a public catalog response. */
export async function findPublicProduct(
  db: Database,
  productId: string,
): Promise<ProductRow | undefined> {
  const [product] = await db.query<ProductRow>(
    `SELECT * FROM products
      WHERE product_id = ? AND ${publicProductPredicates.join(' AND ')}
      LIMIT 1`,
    [productId],
  );
  return product;
}

/** List only products that are valid for public catalog responses. */
export function listPublicProducts(
  db: Database,
  filters: PublicProductFilters = {},
): Promise<ProductRow[]> {
  const where: string[] = [...publicProductPredicates];
  const params: unknown[] = [];

  if (filters.storeId) {
    where.push('store_id = ?');
    params.push(filters.storeId);
  }
  if (filters.keyword) {
    const pattern = `%${filters.keyword.replace(/[!%_]/g, (character) => `!${character}`)}%`;
    where.push("(name LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!')");
    params.push(pattern, pattern);
  }

  return db.query<ProductRow>(
    `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
    params,
  );
}
