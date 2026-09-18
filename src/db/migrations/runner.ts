import { createHash } from 'node:crypto';
import type { Database, SqlExecutor } from '../../db.js';
import {
  DatabaseReadinessError,
  inspectDatabaseReadiness,
  readinessProblems,
  type SchemaRequirements,
} from '../../readiness.js';
import type { Migration } from './types.js';

const HISTORY_TABLE = 'schema_migrations';
const DEFAULT_LOCK_TIMEOUT_SECONDS = 30;

export interface MigrationRunnerOptions {
  lockTimeoutSeconds?: number;
}

export interface MigrationRunResult {
  /** Versions applied by this invocation. Already-applied versions are omitted. */
  appliedVersions: string[];
}

export interface MigrationStatus {
  appliedVersions: string[];
  pendingVersions: string[];
}

export class MigrationRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MigrationRunnerError';
    this.code = code;
  }
}

interface CurrentDatabaseRow {
  databaseName: string | null;
}

interface LockRow {
  result: number | null;
}

interface HistoryRow {
  version: string;
  appliedAt: string;
}

interface TableCountRow {
  count: number | string;
}

const HISTORY_SCHEMA_REQUIREMENTS: SchemaRequirements = {
  tables: { schema_migrations: ['version', 'applied_at'] },
  uniqueKeys: [{ table: 'schema_migrations', column: 'version' }],
};
const SERVER_REQUIREMENTS: SchemaRequirements = { tables: {}, uniqueKeys: [] };

function fail(code: string, message: string): never {
  throw new MigrationRunnerError(code, message);
}

function validateRegistry(migrations: readonly Migration[]): void {
  const versionPattern = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/;
  let previous: string | undefined;
  for (const migration of migrations) {
    if (
      migration.version.length > 32 ||
      !versionPattern.test(migration.version)
    ) {
      fail(
        'MINETENANT_MIGRATION_REGISTRY_INVALID',
        `Migration version is invalid: ${migration.version}`,
      );
    }
    if (previous !== undefined && previous >= migration.version) {
      fail(
        'MINETENANT_MIGRATION_REGISTRY_INVALID',
        'Migration versions must be unique and sorted in ascending order.',
      );
    }
    previous = migration.version;
  }
}

function validateLockTimeout(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 3600) {
    fail(
      'MINETENANT_MIGRATION_OPTIONS_INVALID',
      'lockTimeoutSeconds must be an integer from 0 to 3600.',
    );
  }
}

function migrationLockName(databaseName: string): string {
  const databaseHash = createHash('sha256')
    .update(databaseName.toLowerCase())
    .digest('hex')
    .slice(0, 40);
  return `minetenant:migrate:${databaseHash}`;
}

async function prepareHistoryTable(
  db: SqlExecutor,
  databaseName: string,
): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
    version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const readiness = await inspectDatabaseReadiness(
    db,
    databaseName,
    HISTORY_SCHEMA_REQUIREMENTS,
  );
  if (readinessProblems(readiness).length > 0) {
    fail(
      'MINETENANT_MIGRATION_HISTORY_INVALID',
      `${HISTORY_TABLE} does not match the required schema.`,
    );
  }
}

function validateHistory(
  migrations: readonly Migration[],
  history: readonly HistoryRow[],
): void {
  for (let index = 0; index < history.length; index++) {
    if (history[index]?.version !== migrations[index]?.version) {
      fail(
        'MINETENANT_MIGRATION_HISTORY_INVALID',
        'Applied migrations are not an exact prefix of the local registry.',
      );
    }
  }
}

export async function inspectMigrationStatus(
  db: SqlExecutor,
  migrations: readonly Migration[],
): Promise<MigrationStatus> {
  validateRegistry(migrations);
  const [table] = await db.query<TableCountRow>(
    `SELECT COUNT(*) AS count FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [HISTORY_TABLE],
  );
  const history =
    Number(table?.count) === 0
      ? []
      : await db.query<HistoryRow>(
          `SELECT version, applied_at AS appliedAt
             FROM ${HISTORY_TABLE} ORDER BY version`,
        );
  validateHistory(migrations, history);
  return {
    appliedVersions: history.map(({ version }) => version),
    pendingVersions: migrations
      .slice(history.length)
      .map(({ version }) => version),
  };
}

export async function assertMigrationsCurrent(
  db: SqlExecutor,
  migrations: readonly Migration[],
): Promise<MigrationStatus> {
  const status = await inspectMigrationStatus(db, migrations);
  if (status.pendingVersions.length > 0) {
    fail(
      'MINETENANT_MIGRATION_PENDING',
      `Pending migrations: ${status.pendingVersions.join(', ')}`,
    );
  }
  return status;
}

export async function runMigrations(
  database: Database,
  migrations: readonly Migration[],
  options: MigrationRunnerOptions = {},
): Promise<MigrationRunResult> {
  validateRegistry(migrations);
  const lockTimeoutSeconds =
    options.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS;
  validateLockTimeout(lockTimeoutSeconds);

  return database.withConnection(async (db, lease) => {
    const [current] = await db.query<CurrentDatabaseRow>(
      'SELECT DATABASE() AS databaseName',
    );
    if (!current?.databaseName) {
      fail(
        'MINETENANT_MIGRATION_DATABASE_REQUIRED',
        'A database must be selected before running migrations.',
      );
    }

    const server = await inspectDatabaseReadiness(
      db,
      current.databaseName,
      SERVER_REQUIREMENTS,
    );
    if (!server.versionSupported) throw new DatabaseReadinessError(server);

    const lockName = migrationLockName(current.databaseName);
    const [lock] = await db.query<LockRow>('SELECT GET_LOCK(?, ?) AS result', [
      lockName,
      lockTimeoutSeconds,
    ]);
    if (Number(lock?.result) !== 1) {
      fail(
        'MINETENANT_MIGRATION_LOCK_TIMEOUT',
        'Another migration runner still holds the database lock.',
      );
    }

    const appliedVersions: string[] = [];
    let failure: unknown;
    let failed = false;
    try {
      await prepareHistoryTable(db, current.databaseName);
      const { appliedVersions: history } = await inspectMigrationStatus(
        db,
        migrations,
      );

      for (const migration of migrations.slice(history.length)) {
        // MySQL DDL commits implicitly, so each up must be safely re-runnable.
        await migration.preflight(db);
        await migration.up(db);
        await migration.verify(db);
        const inserted = await db.execute(
          `INSERT INTO ${HISTORY_TABLE} (version) VALUES (?)`,
          [migration.version],
        );
        if (inserted.affectedRows !== 1) {
          fail(
            'MINETENANT_MIGRATION_HISTORY_WRITE_FAILED',
            `Could not record migration ${migration.version}.`,
          );
        }
        appliedVersions.push(migration.version);
      }
    } catch (error) {
      failure = error;
      failed = true;
    }

    try {
      const [released] = await db.query<LockRow>(
        'SELECT RELEASE_LOCK(?) AS result',
        [lockName],
      );
      if (Number(released?.result) !== 1) {
        fail(
          'MINETENANT_MIGRATION_LOCK_RELEASE_FAILED',
          'The database migration lock could not be released.',
        );
      }
    } catch (error) {
      lease.discard();
      if (!failed) {
        failure = error;
        failed = true;
      }
    }

    if (failed) {
      if (failure !== undefined) throw failure;
      fail(
        'MINETENANT_MIGRATION_FAILED',
        'A migration failed without reporting an error.',
      );
    }
    return { appliedVersions };
  });
}
