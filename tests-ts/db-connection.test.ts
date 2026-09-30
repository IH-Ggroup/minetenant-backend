import type { PoolConnection } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import {
  createDatabaseFromPool,
  type Database,
  type DatabasePool,
  type MigrationExecutor,
} from '../src/db.js';
import { runAuthBackfill } from '../src/db/auth-backfill.js';
import { runMigrations } from '../src/db/migrations/runner.js';
import { assertDatabaseServerSupported } from '../src/readiness.js';
import { start, type ServerDependencies } from '../src/server.js';
import { seedDemo } from '../scripts/seed.js';

interface SessionState {
  timeZone?: unknown;
  sqlMode?: unknown;
}

interface ConnectionOptions {
  sessionRows?: readonly unknown[];
  initializationError?: unknown;
  verificationError?: unknown;
  isolationError?: unknown;
  beginError?: unknown;
  businessError?: unknown;
  commitError?: unknown;
  rollbackError?: unknown;
}

class FakeConnection {
  readonly events: string[] = [];
  readonly businessSql: string[] = [];
  readonly options: ConnectionOptions;
  businessRows: object[] = [{ value: 1 }];
  affectedRows = 1;

  constructor(options: ConnectionOptions = {}) {
    this.options = options;
  }

  readonly query = vi.fn(async (sql: string, _params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    if (normalized === "SET SESSION time_zone = '+00:00'") {
      this.events.push('session:set');
      if (this.options.initializationError !== undefined)
        throw this.options.initializationError;
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.includes('@@SESSION.time_zone')) {
      this.events.push('session:verify');
      if (this.options.verificationError !== undefined)
        throw this.options.verificationError;
      return [
        this.options.sessionRows ?? [strictSession('STRICT_TRANS_TABLES')],
        [],
      ];
    }
    if (normalized === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') {
      this.events.push('transaction:isolation');
      if (this.options.isolationError !== undefined)
        throw this.options.isolationError;
      return [{ affectedRows: 0 }, []];
    }

    this.events.push(`business:${normalized}`);
    this.businessSql.push(normalized);
    if (this.options.businessError !== undefined)
      throw this.options.businessError;
    if (/^SELECT\b/iu.test(normalized)) return [this.businessRows, []];
    return [{ affectedRows: this.affectedRows }, []];
  });

  readonly beginTransaction = vi.fn(async () => {
    this.events.push('transaction:begin');
    if (this.options.beginError !== undefined) throw this.options.beginError;
  });

  readonly commit = vi.fn(async () => {
    this.events.push('transaction:commit');
    if (this.options.commitError !== undefined) throw this.options.commitError;
  });

  readonly rollback = vi.fn(async () => {
    this.events.push('transaction:rollback');
    if (this.options.rollbackError !== undefined)
      throw this.options.rollbackError;
  });

  readonly release = vi.fn(() => {
    this.events.push('connection:release');
  });

  readonly destroy = vi.fn(() => {
    this.events.push('connection:destroy');
  });

  asPoolConnection(): PoolConnection {
    return this as unknown as PoolConnection;
  }
}

class FakePool {
  readonly rawQuery = vi.fn(() => {
    throw new Error('Database must not bypass checked physical connections.');
  });
  readonly on = vi.fn(() => {
    throw new Error('Database must not rely on pool connection events.');
  });
  readonly end = vi.fn(async () => undefined);
  readonly getConnection = vi.fn(async () => {
    const connection = this.connections.shift();
    if (!connection) throw new Error('No fake connection remains.');
    return connection.asPoolConnection();
  });

  constructor(private readonly connections: FakeConnection[]) {}

  asDatabasePool(): DatabasePool {
    return this as unknown as DatabasePool;
  }
}

function strictSession(sqlMode: string): SessionState {
  return { timeZone: '+00:00', sqlMode };
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(`private detail for ${code}`), { code });
}

function databaseFor(...connections: FakeConnection[]): {
  database: Database;
  pool: FakePool;
} {
  const pool = new FakePool(connections);
  return {
    database: createDatabaseFromPool(pool.asDatabasePool()),
    pool,
  };
}

function databaseWithPinnedExecutor(
  connection: MigrationExecutor,
  discard: () => void,
): Database {
  return {
    query: <T extends object>(sql: string, params?: unknown[]) =>
      connection.query<T>(sql, params),
    execute: (sql: string, params?: unknown[]) =>
      connection.execute(sql, params),
    transaction: (fn) => connection.transaction(fn),
    withConnection: (fn) => fn(connection, { discard }),
    close: async () => undefined,
  };
}

describe('checked database connections', () => {
  it.each(['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'])(
    'accepts the exact %s mode after pinning the session to UTC',
    async (sqlMode) => {
      const connection = new FakeConnection({
        sessionRows: [strictSession(`NO_ENGINE_SUBSTITUTION,${sqlMode}`)],
      });
      const { database, pool } = databaseFor(connection);

      await expect(
        database.query<{ value: number }>('SELECT 1'),
      ).resolves.toEqual([{ value: 1 }]);

      expect(connection.events).toEqual([
        'session:set',
        'session:verify',
        'business:SELECT 1',
        'connection:release',
      ]);
      expect(connection.destroy).not.toHaveBeenCalled();
      expect(pool.rawQuery).not.toHaveBeenCalled();
      expect(pool.on).not.toHaveBeenCalled();
    },
  );

  it('reinitializes and verifies every query and execute checkout, even for the same physical connection', async () => {
    const connection = new FakeConnection();
    const { database, pool } = databaseFor(connection, connection);

    await expect(
      database.query<{ value: number }>('SELECT 1'),
    ).resolves.toEqual([{ value: 1 }]);
    await expect(
      database.execute(
        'UPDATE products SET stock = stock WHERE product_id = ?',
        ['product-1'],
      ),
    ).resolves.toEqual({ affectedRows: 1 });

    expect(connection.events).toEqual([
      'session:set',
      'session:verify',
      'business:SELECT 1',
      'connection:release',
      'session:set',
      'session:verify',
      'business:UPDATE products SET stock = stock WHERE product_id = ?',
      'connection:release',
    ]);
    expect(pool.getConnection).toHaveBeenCalledTimes(2);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it('pins UTC before timestamp work on every distinct physical connection', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection({
      sessionRows: [strictSession('STRICT_ALL_TABLES')],
    });
    const { database, pool } = databaseFor(first, second);

    await database.query('SELECT CURRENT_TIMESTAMP(6) AS currentTime');
    await database.query('SELECT CURRENT_TIMESTAMP(6) AS currentTime');

    for (const connection of [first, second]) {
      expect(connection.events).toEqual([
        'session:set',
        'session:verify',
        'business:SELECT CURRENT_TIMESTAMP(6) AS currentTime',
        'connection:release',
      ]);
    }
    expect(pool.getConnection).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['query', (db: Database, _body: () => void) => db.query('SELECT secret')],
    [
      'execute',
      (db: Database, _body: () => void) =>
        db.execute('UPDATE users SET display_name = ?', ['hidden']),
    ],
    [
      'transaction',
      (db: Database, body: () => void) =>
        db.transaction(async () => {
          body();
        }),
    ],
    [
      'withConnection',
      (db: Database, body: () => void) =>
        db.withConnection(async () => {
          body();
        }),
    ],
  ] as const)(
    'blocks %s before business work when strict mode is absent',
    async (_name, operation) => {
      const connection = new FakeConnection({
        sessionRows: [strictSession('NO_ENGINE_SUBSTITUTION')],
      });
      const { database } = databaseFor(connection);
      const body = vi.fn();

      await expect(operation(database, body)).rejects.toMatchObject({
        code: 'MINETENANT_DB_STRICT_MODE_REQUIRED',
      });

      expect(body).not.toHaveBeenCalled();
      expect(connection.businessSql).toEqual([]);
      expect(connection.beginTransaction).not.toHaveBeenCalled();
      expect(connection.release).not.toHaveBeenCalled();
      expect(connection.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      'initialization error',
      { initializationError: new Error('private initialization failure') },
      'MINETENANT_DB_SESSION_INITIALIZATION_FAILED',
    ],
    [
      'verification error',
      { verificationError: new Error('private verification failure') },
      'MINETENANT_DB_SESSION_VERIFICATION_FAILED',
    ],
    ['missing row', { sessionRows: [] }, 'MINETENANT_DB_SESSION_STATE_INVALID'],
    [
      'multiple rows',
      {
        sessionRows: [
          strictSession('STRICT_TRANS_TABLES'),
          strictSession('STRICT_TRANS_TABLES'),
        ],
      },
      'MINETENANT_DB_SESSION_STATE_INVALID',
    ],
    [
      'missing sql mode',
      { sessionRows: [{ timeZone: '+00:00' }] },
      'MINETENANT_DB_SESSION_STATE_INVALID',
    ],
    [
      'non-UTC session',
      {
        sessionRows: [{ timeZone: '+09:00', sqlMode: 'STRICT_TRANS_TABLES' }],
      },
      'MINETENANT_DB_UTC_REQUIRED',
    ],
    [
      'strict-looking substring',
      { sessionRows: [strictSession('NO_STRICT_TRANS_TABLES')] },
      'MINETENANT_DB_STRICT_MODE_REQUIRED',
    ],
  ] as const)(
    'destroys a connection and remains fail closed for an invalid %s',
    async (_name, options, expectedCode) => {
      const rejected = new FakeConnection(options);
      const healthy = new FakeConnection();
      const { database } = databaseFor(rejected, healthy);

      await expect(
        database.query('SELECT private_business_data'),
      ).rejects.toMatchObject({ code: expectedCode });
      await expect(
        database.query<{ value: number }>('SELECT 1'),
      ).resolves.toEqual([{ value: 1 }]);

      expect(rejected.businessSql).toEqual([]);
      expect(rejected.release).not.toHaveBeenCalled();
      expect(rejected.destroy).toHaveBeenCalledOnce();
      expect(healthy.events).toEqual([
        'session:set',
        'session:verify',
        'business:SELECT 1',
        'connection:release',
      ]);
    },
  );

  it.each(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])(
    'gets and verifies a fresh connection before retrying %s',
    async (code) => {
      const first = new FakeConnection({ businessError: codedError(code) });
      const second = new FakeConnection();
      const { database, pool } = databaseFor(first, second);

      await expect(
        database.transaction((tx) =>
          tx.execute('UPDATE products SET stock = stock - 1'),
        ),
      ).resolves.toEqual({ affectedRows: 1 });

      expect(first.events).toEqual([
        'session:set',
        'session:verify',
        'transaction:isolation',
        'transaction:begin',
        'business:UPDATE products SET stock = stock - 1',
        'transaction:rollback',
        'connection:release',
      ]);
      expect(second.events).toEqual([
        'session:set',
        'session:verify',
        'transaction:isolation',
        'transaction:begin',
        'business:UPDATE products SET stock = stock - 1',
        'transaction:commit',
        'connection:release',
      ]);
      expect(pool.getConnection).toHaveBeenCalledTimes(2);
    },
  );

  it('destroys a transaction connection when rollback fails and does not retry unrelated errors', async () => {
    const businessError = codedError('ER_BAD_FIELD_ERROR');
    const connection = new FakeConnection({
      businessError,
      rollbackError: new Error('private rollback failure'),
    });
    const { database, pool } = databaseFor(connection);

    await expect(
      database.transaction((tx) =>
        tx.execute('UPDATE missing_table SET x = 1'),
      ),
    ).rejects.toBe(businessError);

    expect(pool.getConnection).toHaveBeenCalledOnce();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'isolation setup',
      'isolationError',
      [
        'session:set',
        'session:verify',
        'transaction:isolation',
        'connection:destroy',
      ],
    ],
    [
      'begin',
      'beginError',
      [
        'session:set',
        'session:verify',
        'transaction:isolation',
        'transaction:begin',
        'connection:destroy',
      ],
    ],
  ] as const)(
    'destroys a transaction connection after an uncertain %s failure',
    async (stage, failureOption, expectedEvents) => {
      const failure = new Error(`private ${stage} failure`);
      const connection = new FakeConnection({ [failureOption]: failure });
      const { database } = databaseFor(connection);

      await expect(
        database.transaction((tx) =>
          tx.execute('UPDATE products SET stock = stock'),
        ),
      ).rejects.toBe(failure);

      expect(connection.events).toEqual(expectedEvents);
      expect(connection.release).not.toHaveBeenCalled();
      expect(connection.destroy).toHaveBeenCalledOnce();
    },
  );

  it('does not retry when a commit response leaves the transaction outcome uncertain', async () => {
    const commitError = codedError('ER_LOCK_DEADLOCK');
    const uncertain = new FakeConnection({ commitError });
    const unusedRetry = new FakeConnection();
    const { database, pool } = databaseFor(uncertain, unusedRetry);

    await expect(
      database.transaction((tx) =>
        tx.execute('UPDATE products SET stock = stock'),
      ),
    ).rejects.toMatchObject({
      code: 'MINETENANT_DB_TRANSACTION_COMMIT_FAILED',
      cause: commitError,
    });

    expect(pool.getConnection).toHaveBeenCalledOnce();
    expect(uncertain.events).toEqual([
      'session:set',
      'session:verify',
      'transaction:isolation',
      'transaction:begin',
      'business:UPDATE products SET stock = stock',
      'transaction:commit',
      'transaction:rollback',
      'connection:destroy',
    ]);
    expect(unusedRetry.events).toEqual([]);
  });

  it('pins named locks and migration transactions to one checked physical connection', async () => {
    const connection = new FakeConnection();
    connection.businessRows = [{ result: 1 }];
    const { database, pool } = databaseFor(connection);

    await database.withConnection(async (db) => {
      await db.query('SELECT GET_LOCK(?, 0) AS result', ['lock-name']);
      await db.transaction((tx) => tx.execute('UPDATE users SET name = name'));
      await db.query('SELECT RELEASE_LOCK(?) AS result', ['lock-name']);
    });

    expect(pool.getConnection).toHaveBeenCalledOnce();
    expect(connection.events).toEqual([
      'session:set',
      'session:verify',
      'business:SELECT GET_LOCK(?, 0) AS result',
      'transaction:begin',
      'business:UPDATE users SET name = name',
      'transaction:commit',
      'business:SELECT RELEASE_LOCK(?) AS result',
      'connection:release',
    ]);
  });

  it('destroys a checked connection exactly once when its lease is discarded', async () => {
    const connection = new FakeConnection();
    const { database } = databaseFor(connection);

    await database.withConnection(async (_db, lease) => {
      lease.discard();
      lease.discard();
    });

    expect(connection.release).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it('discards an auth-backfill connection when named-lock acquisition has an ambiguous failure', async () => {
    const lockError = new Error('private GET_LOCK response failure');
    const discard = vi.fn();
    const connection: MigrationExecutor = {
      async query<T extends object>(sql: string): Promise<T[]> {
        if (sql.startsWith('SELECT DATABASE'))
          return [{ databaseName: 'minetenant' }] as T[];
        if (sql.startsWith('SELECT GET_LOCK')) throw lockError;
        throw new Error(`Unexpected query: ${sql}`);
      },
      async execute() {
        throw new Error('Unexpected execute.');
      },
      async transaction() {
        throw new Error('Unexpected transaction.');
      },
    };

    await expect(
      runAuthBackfill(databaseWithPinnedExecutor(connection, discard), 'check'),
    ).rejects.toBe(lockError);
    expect(discard).toHaveBeenCalledOnce();
  });

  it('discards a migration connection when named-lock acquisition has an ambiguous failure', async () => {
    const lockError = new Error('private GET_LOCK response failure');
    const discard = vi.fn();
    const connection: MigrationExecutor = {
      async query<T extends object>(sql: string): Promise<T[]> {
        if (sql.startsWith('SELECT DATABASE() AS databaseName'))
          return [{ databaseName: 'minetenant' }] as T[];
        if (sql.includes('VERSION() AS version')) {
          return [
            {
              database: 'minetenant',
              version: '8.4.0',
              versionComment: 'MySQL Community Server',
            },
          ] as T[];
        }
        if (
          sql.includes('information_schema.columns') ||
          sql.includes('information_schema.statistics')
        )
          return [];
        if (sql.startsWith('SELECT GET_LOCK')) throw lockError;
        throw new Error(`Unexpected query: ${sql}`);
      },
      async execute() {
        throw new Error('Unexpected execute.');
      },
      async transaction() {
        throw new Error('Unexpected transaction.');
      },
    };

    await expect(
      runMigrations(databaseWithPinnedExecutor(connection, discard), []),
    ).rejects.toBe(lockError);
    expect(discard).toHaveBeenCalledOnce();
  });

  it('closes the underlying pool', async () => {
    const { database, pool } = databaseFor();
    await database.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

describe('fail-closed database entry points', () => {
  function nonStrictDatabase(): {
    database: Database;
    connection: FakeConnection;
  } {
    const connection = new FakeConnection({
      sessionRows: [strictSession('NO_ENGINE_SUBSTITUTION')],
    });
    return { database: databaseFor(connection).database, connection };
  }

  it('blocks startup readiness before its first metadata query', async () => {
    const { database, connection } = nonStrictDatabase();

    await expect(
      assertDatabaseServerSupported(database, 'minetenant'),
    ).rejects.toMatchObject({ code: 'MINETENANT_DB_STRICT_MODE_REQUIRED' });
    expect(connection.businessSql).toEqual([]);
  });

  it('stops API startup before serve and reports only a safe coded error', async () => {
    const { database, connection } = nonStrictDatabase();
    const config = readConfig({
      APP_ENV: 'test',
      DB_HOST: '127.0.0.1',
      DB_PORT: '3306',
      DB_DATABASE: 'minetenant_test',
      DB_USERNAME: 'minetenant',
      DB_PASSWORD: 'never-print-startup-password',
      MINETENANT_ORIGIN_TOKEN: 'never-print-startup-origin-token',
    });
    const serve = vi.fn();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await start({
        readConfig: () => config,
        createDatabase: () => database,
        serve: serve as unknown as ServerDependencies['serve'],
      });

      expect(serve).not.toHaveBeenCalled();
      expect(connection.businessSql).toEqual([]);
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      const output = consoleError.mock.calls.flat().join('\n');
      expect(output).toContain('MINETENANT_DB_STRICT_MODE_REQUIRED');
      expect(output).not.toContain(config.dbPassword);
      expect(output).not.toContain(config.originToken);
    } finally {
      process.exitCode = previousExitCode;
      consoleError.mockRestore();
    }
  });

  it('returns a generic API error without exposing database or token secrets', async () => {
    const { database, connection } = nonStrictDatabase();
    const config = readConfig({
      APP_ENV: 'test',
      DB_PASSWORD: 'never-print-request-password',
      MINETENANT_ORIGIN_TOKEN: 'never-print-request-origin-token',
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const response = await createApp({ db: database, config }).request(
        '/api/v1/products',
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: 'Server Error' });
      expect(connection.businessSql).toEqual([]);
      const output = consoleError.mock.calls.flat().join('\n');
      expect(output).toContain('MINETENANT_DB_STRICT_MODE_REQUIRED');
      expect(output).not.toContain(config.dbPassword);
      expect(output).not.toContain(config.originToken);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('blocks migrations before database inspection or named-lock acquisition', async () => {
    const { database, connection } = nonStrictDatabase();

    await expect(runMigrations(database, [])).rejects.toMatchObject({
      code: 'MINETENANT_DB_STRICT_MODE_REQUIRED',
    });
    expect(connection.businessSql).toEqual([]);
  });

  it('blocks seed transactions before reading or writing application tables', async () => {
    const { database, connection } = nonStrictDatabase();

    await expect(seedDemo(database, 4)).rejects.toMatchObject({
      code: 'MINETENANT_DB_STRICT_MODE_REQUIRED',
    });
    expect(connection.businessSql).toEqual([]);
    expect(connection.beginTransaction).not.toHaveBeenCalled();
  });
});
