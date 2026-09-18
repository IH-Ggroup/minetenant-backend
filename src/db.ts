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

function migrationExecutor(
  connection: PoolConnection,
  discard: () => void,
): MigrationExecutor {
  const sql = executor(connection);
  let inTransaction = false;
  return {
    ...sql,
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      if (inTransaction)
        throw new Error('Nested transactions are not allowed.');
      inTransaction = true;
      await connection.beginTransaction();
      try {
        const result = await fn(sql);
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          discard();
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };
}

function executor(connection: Pool | PoolConnection): SqlExecutor {
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
  // Keep MySQL sessions and JavaScript timestamp conversion on UTC.
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  return {
    ...executor(pool),
    async withConnection<T>(
      fn: (connection: MigrationExecutor, lease: ConnectionLease) => Promise<T>,
    ): Promise<T> {
      const connection = await pool.getConnection();
      let discard = false;
      const discardConnection = () => {
        discard = true;
      };
      try {
        return await fn(migrationExecutor(connection, discardConnection), {
          discard: discardConnection,
        });
      } finally {
        if (discard) connection.destroy();
        else connection.release();
      }
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const connection = await pool.getConnection();
        try {
          // Explicit row locks protect business updates; avoid gap locks on new request IDs.
          await connection.query(
            'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
          );
          await connection.beginTransaction();
          const result = await fn(executor(connection));
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          const code = (error as { code?: string }).code;
          if (
            attempt >= 2 ||
            (code !== 'ER_LOCK_DEADLOCK' && code !== 'ER_LOCK_WAIT_TIMEOUT')
          )
            throw error;
        } finally {
          connection.release();
        }
      }
    },
    close: () => pool.end(),
  };
}
