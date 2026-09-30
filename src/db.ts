import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type { AppConfig } from './config.js';

export interface SqlExecutor {
  query<T extends object>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;
}

export interface ConnectionLease {
  /** Prevent a connection with uncertain session state from returning to the pool. */
  discard(): void;
}

export interface MigrationExecutor extends SqlExecutor {
  /** Use only for DML-only atomic sections; MySQL DDL commits implicitly. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface Database extends SqlExecutor {
  withConnection<T>(
    fn: (connection: MigrationExecutor, lease: ConnectionLease) => Promise<T>,
  ): Promise<T>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DatabasePool = Pick<Pool, 'getConnection' | 'end'>;

type DatabaseConnectionErrorCode =
  | 'MINETENANT_DB_SESSION_INITIALIZATION_FAILED'
  | 'MINETENANT_DB_SESSION_VERIFICATION_FAILED'
  | 'MINETENANT_DB_SESSION_STATE_INVALID'
  | 'MINETENANT_DB_UTC_REQUIRED'
  | 'MINETENANT_DB_STRICT_MODE_REQUIRED'
  | 'MINETENANT_DB_TRANSACTION_COMMIT_FAILED';

export class DatabaseConnectionError extends Error {
  readonly code: DatabaseConnectionErrorCode;

  constructor(
    code: DatabaseConnectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DatabaseConnectionError';
    this.code = code;
  }
}

interface SessionStateRow {
  timeZone: unknown;
  sqlMode: unknown;
}

function connectionFailure(
  code: DatabaseConnectionErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new DatabaseConnectionError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

async function prepareConnection(connection: PoolConnection): Promise<void> {
  try {
    await connection.query("SET SESSION time_zone = '+00:00'");
  } catch (error) {
    connectionFailure(
      'MINETENANT_DB_SESSION_INITIALIZATION_FAILED',
      'The database connection session could not be initialized.',
      error,
    );
  }

  let rows: unknown;
  try {
    [rows] = await connection.query<RowDataPacket[]>(
      `SELECT @@SESSION.time_zone AS timeZone,
              @@SESSION.sql_mode AS sqlMode`,
    );
  } catch (error) {
    connectionFailure(
      'MINETENANT_DB_SESSION_VERIFICATION_FAILED',
      'The database connection session could not be verified.',
      error,
    );
  }

  if (!Array.isArray(rows) || rows.length !== 1) {
    connectionFailure(
      'MINETENANT_DB_SESSION_STATE_INVALID',
      'The database connection returned an invalid session state.',
    );
  }
  const state = rows[0] as SessionStateRow | undefined;
  if (
    !state ||
    typeof state.timeZone !== 'string' ||
    typeof state.sqlMode !== 'string'
  ) {
    connectionFailure(
      'MINETENANT_DB_SESSION_STATE_INVALID',
      'The database connection returned an invalid session state.',
    );
  }
  if (state.timeZone !== '+00:00') {
    connectionFailure(
      'MINETENANT_DB_UTC_REQUIRED',
      'The database connection is not pinned to UTC.',
    );
  }
  const sqlModes = new Set(
    state.sqlMode
      .split(',')
      .map((mode) => mode.trim().toUpperCase())
      .filter(Boolean),
  );
  if (
    !sqlModes.has('STRICT_TRANS_TABLES') &&
    !sqlModes.has('STRICT_ALL_TABLES')
  ) {
    connectionFailure(
      'MINETENANT_DB_STRICT_MODE_REQUIRED',
      'The database connection requires a strict SQL mode.',
    );
  }
}

async function withCheckedConnection<T>(
  pool: DatabasePool,
  fn: (connection: PoolConnection, lease: ConnectionLease) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  let discard = false;
  const lease: ConnectionLease = {
    discard() {
      discard = true;
    },
  };
  try {
    try {
      // Both round trips are intentional on every checkout. Caching verification
      // by physical connection could miss session state changed by a prior lease.
      await prepareConnection(connection);
    } catch (error) {
      lease.discard();
      throw error;
    }
    return await fn(connection, lease);
  } finally {
    if (discard) connection.destroy();
    else connection.release();
  }
}

async function runConnectionTransaction<T>(
  connection: PoolConnection,
  lease: ConnectionLease,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  let started = false;
  let commitAttempted = false;
  try {
    await connection.beginTransaction();
    started = true;
    const result = await fn(executor(connection));
    commitAttempted = true;
    await connection.commit();
    return result;
  } catch (error) {
    if (!started || commitAttempted) lease.discard();
    if (started) {
      try {
        await connection.rollback();
      } catch {
        lease.discard();
      }
    }
    if (commitAttempted) {
      connectionFailure(
        'MINETENANT_DB_TRANSACTION_COMMIT_FAILED',
        'The database transaction commit result could not be confirmed.',
        error,
      );
    }
    throw error;
  }
}

function migrationExecutor(
  connection: PoolConnection,
  lease: ConnectionLease,
): MigrationExecutor {
  const sql = executor(connection);
  let inTransaction = false;
  return {
    ...sql,
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      if (inTransaction)
        throw new Error('Nested transactions are not allowed.');
      inTransaction = true;
      try {
        return await runConnectionTransaction(connection, lease, fn);
      } finally {
        inTransaction = false;
      }
    },
  };
}

function executor(connection: PoolConnection): SqlExecutor {
  return {
    async query<T extends object>(sql: string, params: unknown[] = []) {
      const [rows] = await connection.query<RowDataPacket[]>(sql, params);
      return rows as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const [result] = await connection.query<ResultSetHeader>(sql, params);
      return { affectedRows: result.affectedRows };
    },
  };
}

export function createDatabase(config: AppConfig): Database {
  const pool = mysql.createPool({
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbDatabase,
    user: config.dbUsername,
    password: config.dbPassword,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    connectionLimit: 10,
    multipleStatements: false,
  });
  return createDatabaseFromPool(pool);
}

/** Build a Database around an injectable pool while preserving checkout invariants. */
export function createDatabaseFromPool(pool: DatabasePool): Database {
  return {
    query: <T extends object>(sql: string, params?: unknown[]) =>
      withCheckedConnection(pool, (connection) =>
        executor(connection).query<T>(sql, params),
      ),
    execute: (sql: string, params?: unknown[]) =>
      withCheckedConnection(pool, (connection) =>
        executor(connection).execute(sql, params),
      ),
    async withConnection<T>(
      fn: (connection: MigrationExecutor, lease: ConnectionLease) => Promise<T>,
    ): Promise<T> {
      return withCheckedConnection(pool, (connection, lease) =>
        fn(migrationExecutor(connection, lease), lease),
      );
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await withCheckedConnection(
            pool,
            async (connection, lease) => {
              try {
                // Explicit row locks protect business updates; avoid gap locks on new request IDs.
                await connection.query(
                  'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
                );
              } catch (error) {
                lease.discard();
                throw error;
              }
              return runConnectionTransaction(connection, lease, fn);
            },
          );
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (
            attempt >= 2 ||
            (code !== 'ER_LOCK_DEADLOCK' && code !== 'ER_LOCK_WAIT_TIMEOUT')
          )
            throw error;
        }
      }
    },
    close: () => pool.end(),
  };
}
