import type { MigrationExecutor } from '../../db.js';
import {
  applyAuthBackfill,
  prepareAuthBackfillSession,
  validateAuthBackfillInput,
  verifyMigrationAuthData,
} from '../auth-backfill.js';
import {
  assertExpandedAuthSchema,
  AUTH_USERNAME_MIGRATION_VERSION,
  ensureUsernameUniqueIndex,
  expandAuthSchema,
  inspectAuthSchema,
} from '../auth-schema.js';
import type { Migration } from './types.js';

export const usernameAuthMigration: Migration = {
  version: AUTH_USERNAME_MIGRATION_VERSION,
  async preflight(db: MigrationExecutor): Promise<void> {
    await prepareAuthBackfillSession(db);
    const schema = await inspectAuthSchema(db);
    if (schema.expanded) await validateAuthBackfillInput(db);
  },
  async up(db: MigrationExecutor): Promise<void> {
    await prepareAuthBackfillSession(db);
    await expandAuthSchema(db);
    await applyAuthBackfill(db);
    await ensureUsernameUniqueIndex(db);
  },
  async verify(db: MigrationExecutor): Promise<void> {
    await prepareAuthBackfillSession(db);
    await assertExpandedAuthSchema(db);
    await verifyMigrationAuthData(db);
  },
};
