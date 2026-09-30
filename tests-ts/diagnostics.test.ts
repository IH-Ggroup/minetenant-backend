import { describe, expect, it } from 'vitest';
import { formatMigrationError } from '../scripts/migrate.js';
import { formatSeedError } from '../scripts/seed.js';
import { readConfig } from '../src/config.js';
import { DatabaseConnectionError } from '../src/db.js';
import { AuthBackfillDataError } from '../src/db/auth-backfill.js';
import {
  databaseDiagnostic,
  formatErrorForLog,
  supportsNodeVersion,
} from '../src/diagnostics.js';
import {
  assertSafeBootstrapTarget,
  quoteDatabaseName,
  readApplicationUserHosts,
} from '../scripts/db-bootstrap.js';
import { assertAdditiveSchemaSafe } from '../src/readiness.js';

const config = readConfig({
  APP_ENV: 'local',
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_DATABASE: 'minetenant',
  DB_USERNAME: 'minetenant',
  DB_PASSWORD: 'never-print-this-password',
});

describe('database diagnostics', () => {
  it('checks the minimum Node.js version used by the lockfile', () => {
    expect(supportsNodeVersion('22.22.2')).toBe(true);
    expect(supportsNodeVersion('23.0.0')).toBe(true);
    expect(supportsNodeVersion('22.22.1')).toBe(false);
    expect(supportsNodeVersion('invalid')).toBe(false);
  });

  it('turns missing-user and missing-database errors into actionable messages', () => {
    for (const code of ['ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR']) {
      const output = formatErrorForLog(
        'SETUP_FAILED',
        Object.assign(new Error('contains sensitive driver details'), { code }),
        config,
      );
      expect(output).toContain(code);
      expect(output).toContain('npm run dev');
      expect(output).not.toContain(config.dbPassword);
      expect(output).not.toContain('sensitive driver details');
    }
  });

  it('explains a stopped MySQL server without leaking the driver message', () => {
    const error = Object.assign(new Error('secret connection detail'), {
      code: 'ECONNREFUSED',
    });
    expect(databaseDiagnostic(error)?.summary).toContain('MySQL');
    expect(formatErrorForLog('DOCTOR_FAILED', error, config)).toContain(
      'DB_HOST',
    );
    expect(formatErrorForLog('DOCTOR_FAILED', error, config)).not.toContain(
      error.message,
    );
  });

  it('refuses API startup while registered migrations are pending', () => {
    const error = Object.assign(new Error('0001_private_detail'), {
      code: 'MINETENANT_MIGRATION_PENDING',
    });
    const output = formatErrorForLog('API_STARTUP_FAILED', error, config);
    expect(output).toContain('MINETENANT_MIGRATION_PENDING');
    expect(output).toContain('npm run db:migrate');
    expect(output).not.toContain(error.message);
  });

  it('explains an unsafe entity-ID migration without exposing schema details', () => {
    const error = Object.assign(new Error('private schema inspection detail'), {
      code: 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE',
    });
    const output = formatErrorForLog('SETUP_FAILED', error, config);
    expect(output).toContain('MINETENANT_ENTITY_ID_MIGRATION_UNSAFE');
    expect(output).toContain('バックアップ');
    expect(output).not.toContain(error.message);
  });

  it('explains an unsafe product-status migration without exposing schema details', () => {
    const error = Object.assign(new Error('private product migration detail'), {
      code: 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE',
    });
    const output = formatErrorForLog('SETUP_FAILED', error, config);
    expect(output).toContain('MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE');
    expect(output).toContain('db:bootstrap');
    expect(output).toContain('TRIGGER');
    expect(output).not.toContain(error.message);
  });

  it.each([
    ['MINETENANT_DB_SESSION_INITIALIZATION_FAILED', 'SET SESSION'],
    ['MINETENANT_DB_SESSION_VERIFICATION_FAILED', 'session変数'],
    ['MINETENANT_DB_SESSION_STATE_INVALID', 'DB proxy'],
    ['MINETENANT_DB_UTC_REQUIRED', "time_zone = '+00:00'"],
    ['MINETENANT_DB_STRICT_MODE_REQUIRED', 'STRICT_TRANS_TABLES'],
    ['MINETENANT_DB_TRANSACTION_COMMIT_FAILED', 'requestId'],
  ])(
    'explains %s without exposing nested database details',
    (code, expectedAction) => {
      const errorMessage = `wrapper-message:${config.dbPassword}`;
      const causeMessage = `driver-cause:${config.dbPassword}`;
      const error = Object.assign(
        new Error(errorMessage, { cause: new Error(causeMessage) }),
        {
          code,
          sql: 'SELECT private_column FROM private_table',
        },
      );

      const output = formatErrorForLog('API_STARTUP_FAILED', error, config);

      expect(output).toContain(code);
      expect(output).toContain(expectedAction);
      expect(output).toContain('npm run doctor');
      expect(output).not.toContain(errorMessage);
      expect(output).not.toContain(causeMessage);
      expect(output).not.toContain(config.dbPassword);
      expect(output).not.toContain(error.sql);
    },
  );

  it('keeps the direct seed command free of nested driver details', () => {
    const driverError = Object.assign(
      new Error(`driver-cause:${config.dbPassword}`),
      {
        code: 'ER_PARSE_ERROR',
        sql: 'INSERT INTO users (password_hash) VALUES (?)',
        values: [
          'password-hash:$2b$12$never-print-this-value',
          'session-token:never-print-this-value',
          'sql-parameter:never-print-this-value',
        ],
      },
    );
    const error = new DatabaseConnectionError(
      'MINETENANT_DB_SESSION_INITIALIZATION_FAILED',
      `wrapper-message:${config.dbPassword}`,
      { cause: driverError },
    );

    const output = formatSeedError(error, config);

    expect(output).toContain('MINETENANT_DB_SESSION_INITIALIZATION_FAILED');
    expect(output).not.toContain(config.dbPassword);
    expect(output).not.toContain(driverError.message);
    expect(output).not.toContain(driverError.sql);
    for (const value of driverError.values) expect(output).not.toContain(value);
  });

  it('keeps auth migration diagnostics free of row identifiers and secrets', () => {
    const error = new AuthBackfillDataError(
      [
        {
          userId: 'private-user@example.test',
          violationCode: 'PASSWORD_HASH_INVALID',
        },
      ],
      1,
      1,
    );
    const output = formatMigrationError(error, config);

    expect(Object.keys(error)).not.toContain('violations');
    expect(output).toContain('MINETENANT_AUTH_BACKFILL_DATA_INVALID');
    expect(output).toContain('docs/auth-cutover.md');
    expect(output).not.toContain('private-user@example.test');
    expect(output).not.toContain(error.message);
  });

  it('rejects unsafe database identifiers used by the administrator command', () => {
    expect(quoteDatabaseName('minetenant_test')).toBe('`minetenant_test`');
    expect(() => quoteDatabaseName('minetenant; DROP DATABASE mysql')).toThrow(
      'letters, numbers and underscores',
    );
  });

  it('keeps administrator bootstrap on a loopback non-system database', () => {
    expect(() => assertSafeBootstrapTarget(config)).not.toThrow();
    expect(() =>
      assertSafeBootstrapTarget({ ...config, dbHost: 'db.example.test' }),
    ).toThrow('localhost');
    expect(() =>
      assertSafeBootstrapTarget({ ...config, dbDatabase: 'mysql' }),
    ).toThrow('system database');
    expect(() =>
      assertSafeBootstrapTarget({ ...config, dbDatabase: 'MineTenant_Test' }),
    ).toThrow('reserved minetenant_test');
    expect(() =>
      assertSafeBootstrapTarget({ ...config, dbUsername: '' }),
    ).toThrow('DB_USERNAME');
    expect(() =>
      assertSafeBootstrapTarget({ ...config, dbPassword: '' }),
    ).toThrow('DB_PASSWORD');
  });

  it('only permits a wildcard application account in an explicit CI bootstrap', () => {
    expect(readApplicationUserHosts({})).toEqual(['localhost', '127.0.0.1']);
    expect(
      readApplicationUserHosts({ CI: 'true', DB_BOOTSTRAP_USER_HOSTS: '%' }),
    ).toEqual(['%']);
    expect(() =>
      readApplicationUserHosts({ DB_BOOTSTRAP_USER_HOSTS: '%' }),
    ).toThrow('only allowed in CI');
  });

  it('checks server and existing schema safety before bootstrap mutations', () => {
    const safe = {
      database: 'minetenant',
      version: '8.4.11',
      versionComment: 'MySQL Community Server',
      versionSupported: true,
      missingTables: ['hono_sessions'],
      missingColumns: [],
      missingUniqueKeys: [],
      invalidTables: [],
      invalidTriggers: [],
    };
    expect(() => assertAdditiveSchemaSafe(safe)).not.toThrow();
    expect(() =>
      assertAdditiveSchemaSafe({
        ...safe,
        missingTables: ['product_status_migration_product_audit'],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'MINETENANT_SCHEMA_MISMATCH' }),
    );
    expect(() =>
      assertAdditiveSchemaSafe({
        ...safe,
        missingTables: [],
        missingColumns: ['users.password'],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'MINETENANT_SCHEMA_MISMATCH' }),
    );
    expect(() =>
      assertAdditiveSchemaSafe({
        ...safe,
        missingTables: [],
        invalidTables: ['product_status_migration_product_audit'],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'MINETENANT_SCHEMA_MISMATCH' }),
    );
    expect(() =>
      assertAdditiveSchemaSafe({
        ...safe,
        missingTables: [],
        invalidTriggers: ['products_status_compatibility_before_update'],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'MINETENANT_SCHEMA_MISMATCH' }),
    );
    expect(() =>
      assertAdditiveSchemaSafe({
        ...safe,
        version: '11.4.8-MariaDB',
        versionComment: 'MariaDB Server',
        versionSupported: false,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'MINETENANT_DATABASE_UNSUPPORTED' }),
    );
  });

  it('prints an unknown safe error code without leaking the driver message', () => {
    const output = formatErrorForLog(
      'API_REQUEST_FAILED',
      Object.assign(new Error('private SQL and values'), {
        code: 'ER_PARSE_ERROR',
      }),
      config,
    );
    expect(output).toContain('ER_PARSE_ERROR');
    expect(output).not.toContain('private SQL and values');
  });
});
