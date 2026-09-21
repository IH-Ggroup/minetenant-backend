import type { MigrationExecutor } from '../../db.js';

/**
 * A version is recorded only after both steps finish successfully.
 * Keep up idempotent because MySQL may commit DDL before a later statement fails.
 */
export interface Migration {
  readonly version: string;
  preflight(db: MigrationExecutor): Promise<void>;
  up(db: MigrationExecutor): Promise<void>;
  verify(db: MigrationExecutor): Promise<void>;
}
