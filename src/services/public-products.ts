import type { Database } from '../db.js';
import type { ProductRow } from '../domain/types.js';

export interface PublicProductFilters {
  readonly storeId?: string;
  readonly keyword?: string;
}

/** List only products that are valid for public catalog responses. */
export function listPublicProducts(
  db: Database,
  filters: PublicProductFilters = {},
): Promise<ProductRow[]> {
  const where = [
    'deleted_at IS NULL',
    "BINARY status IN ('available', 'sold')",
  ];
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
