import { initialSchemaMigration } from './0000-initial-schema.js';
import { entityIdColumnsMigration } from './0001-entity-id-columns.js';

export { initialSchemaMigration } from './0000-initial-schema.js';
export {
  ENTITY_ID_SCHEMA_REQUIREMENTS,
  EntityIdMigrationError,
  entityIdColumnsMigration,
} from './0001-entity-id-columns.js';
export {
  MigrationRunnerError,
  assertMigrationsCurrent,
  inspectMigrationStatus,
  runMigrations,
  type MigrationRunnerOptions,
  type MigrationRunResult,
  type MigrationStatus,
} from './runner.js';
export type { Migration } from './types.js';

export const migrations = [
  initialSchemaMigration,
  entityIdColumnsMigration,
] as const;
