import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
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
    };
    expect(() => assertAdditiveSchemaSafe(safe)).not.toThrow();
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
