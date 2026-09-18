import type { MigrationExecutor } from '../../db.js';
import {
  assertAdditiveSchemaSafe,
  DatabaseReadinessError,
  INITIAL_SCHEMA_REQUIREMENTS,
  inspectDatabaseReadiness,
  readinessProblems,
} from '../../readiness.js';
import type { Migration } from './types.js';

const tables = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(255) PRIMARY KEY, name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL, role VARCHAR(32) NOT NULL,
    role_label VARCHAR(255) NOT NULL, avatar_initial VARCHAR(8) NOT NULL,
    created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL,
    INDEX users_role_index(role)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS stores (
    id VARCHAR(255) PRIMARY KEY, owner_id VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL, description TEXT NOT NULL,
    level SMALLINT UNSIGNED NOT NULL DEFAULT 1, points INT UNSIGNED NOT NULL DEFAULT 0,
    sync_status VARCHAR(32) NOT NULL DEFAULT 'offline', created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL,
    INDEX stores_sync_status_index(sync_status),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(255) PRIMARY KEY, store_id VARCHAR(255) NOT NULL, seller_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL, description TEXT NOT NULL,
    price INT UNSIGNED NOT NULL, stock INT UNSIGNED NOT NULL,
    category VARCHAR(32) NOT NULL, theme VARCHAR(32) NOT NULL, emoji VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL,
    INDEX products_category_index(category), INDEX products_created_at_index(created_at),
    INDEX products_store_id_created_at_index(store_id,created_at),
    INDEX products_seller_id_created_at_index(seller_id,created_at),
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE RESTRICT,
    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS purchase_transactions (
    id VARCHAR(255) PRIMARY KEY, request_id VARCHAR(255) NOT NULL,
    product_id VARCHAR(255) NOT NULL, buyer_id VARCHAR(255) NOT NULL, seller_id VARCHAR(255) NOT NULL,
    source VARCHAR(32) NOT NULL, amount INT UNSIGNED NOT NULL, status VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL,
    UNIQUE KEY purchase_transactions_request_id_unique(request_id),
    INDEX purchase_transactions_product_id_index(product_id),
    INDEX purchase_transactions_source_index(source), INDEX purchase_transactions_status_index(status),
    INDEX purchase_transactions_buyer_id_created_at_index(buyer_id,created_at),
    INDEX purchase_transactions_seller_id_created_at_index(seller_id,created_at),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS hono_sessions (
    id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    user_id VARCHAR(255) NULL, csrf_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at BIGINT NOT NULL, INDEX hono_sessions_expiry(expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS hono_rate_limits (
    key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    hits INT UNSIGNED NOT NULL, expires_at BIGINT NOT NULL,
    INDEX hono_rate_limits_expiry(expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
] as const;

interface CurrentDatabaseRow {
  databaseName: string | null;
}

async function inspectInitialSchema(db: MigrationExecutor) {
  const [current] = await db.query<CurrentDatabaseRow>(
    'SELECT DATABASE() AS databaseName',
  );
  if (!current?.databaseName) {
    throw new Error('A database must be selected before running migrations.');
  }
  return inspectDatabaseReadiness(
    db,
    current.databaseName,
    INITIAL_SCHEMA_REQUIREMENTS,
  );
}

export const initialSchemaMigration: Migration = {
  version: '0000_initial_schema',
  async preflight(db: MigrationExecutor): Promise<void> {
    assertAdditiveSchemaSafe(await inspectInitialSchema(db));
  },
  async up(db: MigrationExecutor): Promise<void> {
    for (const sql of tables) await db.execute(sql);
  },
  async verify(db: MigrationExecutor): Promise<void> {
    const readiness = await inspectInitialSchema(db);
    if (readinessProblems(readiness).length > 0) {
      throw new DatabaseReadinessError(readiness);
    }
  },
};
