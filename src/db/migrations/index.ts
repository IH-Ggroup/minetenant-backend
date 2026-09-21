import { initialSchemaMigration } from './0000-initial-schema.js';

export { initialSchemaMigration } from './0000-initial-schema.js';
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

export const migrations = [initialSchemaMigration] as const;
