import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDoctorReadinessFailure } from '../scripts/doctor.ts';
import {
  doctorNeedsBootstrap,
  doctorNeedsSafeSetup,
  envWithUniqueDatabaseCredentials,
  ensureEnvFile,
  npmInvocation,
  parseEnvFile,
  prepareDatabaseForDevelopment,
  readDatabaseSettings,
  runtimeDependenciesCurrent,
  runtimeDependenciesPresent,
  supportsNodeRuntime,
  writeDependencySentinel,
} from '../scripts/predev.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'minetenant-predev-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function result(status, output = '') {
  return { error: undefined, status, stderr: output, stdout: '' };
}

describe('dependency-free development preflight', () => {
  it('rejects an old Node.js runtime before dependency installation', () => {
    expect(supportsNodeRuntime('22.22.2')).toBe(true);
    expect(supportsNodeRuntime('23.0.0')).toBe(true);
    expect(supportsNodeRuntime('22.22.1')).toBe(false);
    expect(supportsNodeRuntime('invalid')).toBe(false);
  });

  it('uses npm_execpath through Node when available and npm.cmd on Windows otherwise', () => {
    expect(
      npmInvocation(
        ['ci'],
        { npm_execpath: '/npm/npm-cli.js' },
        'win32',
        '/node',
      ),
    ).toEqual({
      command: '/node',
      args: ['/npm/npm-cli.js', 'ci'],
    });
    expect(npmInvocation(['ci'], {}, 'win32', '/node')).toEqual({
      command: 'npm.cmd',
      args: ['ci'],
    });
  });

  it('creates .env once and never overwrites an existing environment', async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, '.env.example'),
      'DB_USERNAME=minetenant\nDB_PASSWORD=example\n',
    );

    await expect(ensureEnvFile(directory)).resolves.toBe('created');
    const generated = await readFile(join(directory, '.env'), 'utf8');
    expect(generated).toMatch(/DB_USERNAME=minetenant_dev_[a-f0-9]{12}/);
    expect(generated).not.toContain('DB_PASSWORD=example');
    await writeFile(join(directory, '.env'), 'DB_PASSWORD=local-secret\n');
    await expect(ensureEnvFile(directory)).resolves.toBe('preserved');
    await expect(readFile(join(directory, '.env'), 'utf8')).resolves.toBe(
      'DB_PASSWORD=local-secret\n',
    );
  });

  it('generates MySQL-safe clone credentials without logging or reusing template secrets', () => {
    const values = [Buffer.alloc(6, 0xab), Buffer.alloc(24, 0xcd)];
    const generated = envWithUniqueDatabaseCredentials(
      'DB_USERNAME=minetenant\nDB_PASSWORD=minetenant\n',
      () => values.shift(),
    );
    const settings = parseEnvFile(generated);
    expect(settings.DB_USERNAME).toBe('minetenant_dev_abababababab');
    expect(settings.DB_USERNAME).toMatch(/^[A-Za-z0-9_]{1,32}$/);
    expect(settings.DB_PASSWORD).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(settings.DB_PASSWORD).not.toBe('minetenant');
  });

  it('detects only a complete runtime install', async () => {
    const directory = await temporaryDirectory();
    expect(runtimeDependenciesPresent(directory)).toBe(false);
    for (const path of [
      'node_modules/.bin/tsx',
      'node_modules/@hono/node-server/package.json',
      'node_modules/dotenv/package.json',
      'node_modules/hono/package.json',
      'node_modules/mysql2/package.json',
    ]) {
      const absolute = join(directory, path);
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, '');
    }
    expect(runtimeDependenciesPresent(directory, undefined, 'linux')).toBe(
      true,
    );
  });

  it('invalidates installed dependencies whenever package-lock.json changes', async () => {
    const directory = await temporaryDirectory();
    for (const path of [
      'node_modules/.bin/tsx',
      'node_modules/@hono/node-server/package.json',
      'node_modules/dotenv/package.json',
      'node_modules/hono/package.json',
      'node_modules/mysql2/package.json',
    ]) {
      const absolute = join(directory, path);
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, '');
    }
    await writeFile(join(directory, 'package-lock.json'), '{"version":1}\n');
    await expect(
      runtimeDependenciesCurrent(directory, undefined, 'linux'),
    ).resolves.toBe(false);

    await writeDependencySentinel(directory);
    await expect(
      runtimeDependenciesCurrent(directory, undefined, 'linux'),
    ).resolves.toBe(true);

    await writeFile(join(directory, 'package-lock.json'), '{"version":2}\n');
    await expect(
      runtimeDependenciesCurrent(directory, undefined, 'linux'),
    ).resolves.toBe(false);
  });

  it('reads the local database endpoint without exposing unrelated values', () => {
    const contents = `
      APP_ENV=local
      DB_HOST="localhost"
      DB_PORT=3307 # local test port
      DB_PASSWORD=must-not-be-returned
    `;
    expect(parseEnvFile(contents)).toMatchObject({
      DB_HOST: 'localhost',
      DB_PASSWORD: 'must-not-be-returned',
      DB_PORT: '3307',
    });
    expect(readDatabaseSettings(contents)).toEqual({
      appEnv: 'local',
      host: 'localhost',
      port: 3307,
    });
  });

  it('only classifies missing-user or missing-database diagnostics for bootstrap', () => {
    expect(doctorNeedsBootstrap('DOCTOR_FAILED [ER_BAD_DB_ERROR]')).toBe(true);
    expect(doctorNeedsBootstrap('DOCTOR_FAILED [ER_ACCESS_DENIED_ERROR]')).toBe(
      true,
    );
    expect(
      doctorNeedsBootstrap('DOCTOR_FAILED [MINETENANT_SCHEMA_MISMATCH]'),
    ).toBe(false);
    expect(doctorNeedsBootstrap('DOCTOR_FAILED [ECONNREFUSED]')).toBe(false);
    expect(
      doctorNeedsSafeSetup('DOCTOR_FAILED [MINETENANT_SCHEMA_INCOMPLETE]'),
    ).toBe(false);
    expect(
      doctorNeedsSafeSetup('DOCTOR_FAILED [MINETENANT_SCHEMA_MISMATCH]'),
    ).toBe(false);
    expect(
      doctorNeedsSafeSetup('DOCTOR_FAILED [MINETENANT_MIGRATION_PENDING]'),
    ).toBe(true);
  });

  it('recognizes the coded output produced by the real doctor formatter', () => {
    const output = formatDoctorReadinessFailure({
      database: 'minetenant',
      version: '8.4.11',
      versionComment: 'MySQL Community Server',
      versionSupported: true,
      missingTables: ['hono_sessions'],
      missingColumns: [],
      missingUniqueKeys: [],
    });
    expect(output).toContain('[MINETENANT_SCHEMA_INCOMPLETE]');
    expect(doctorNeedsSafeSetup(output)).toBe(false);
  });

  it('runs bootstrap only for a missing local DB/user and re-runs doctor', async () => {
    const events = [];
    const doctorResults = [
      result(1, 'DOCTOR_FAILED [ER_BAD_DB_ERROR]'),
      result(0, 'diagnosis ok'),
    ];
    await expect(
      prepareDatabaseForDevelopment({
        settings: { appEnv: 'local', host: '127.0.0.1', port: 3306 },
        probe: async () => events.push('probe'),
        runDoctor: async () => {
          events.push('doctor');
          return doctorResults.shift();
        },
        runBootstrap: async () => {
          events.push('bootstrap');
          return result(0);
        },
        runSetup: async () => {
          events.push('setup');
          return result(0);
        },
        showDoctorResult: () => events.push('show-doctor'),
        log: () => events.push('explain-bootstrap'),
      }),
    ).resolves.toBe('bootstrapped');
    expect(events).toEqual([
      'probe',
      'doctor',
      'show-doctor',
      'explain-bootstrap',
      'bootstrap',
      'doctor',
      'show-doctor',
    ]);
  });

  it('applies pending migrations on a local database and re-runs doctor', async () => {
    const events = [];
    const explanations = [];
    const doctorResults = [
      result(1, 'DOCTOR_FAILED [MINETENANT_MIGRATION_PENDING]'),
      result(0, 'diagnosis ok'),
    ];
    await expect(
      prepareDatabaseForDevelopment({
        settings: { appEnv: 'local', host: 'localhost', port: 3306 },
        probe: async () => events.push('probe'),
        runDoctor: async () => {
          events.push('doctor');
          return doctorResults.shift();
        },
        runBootstrap: async () => {
          events.push('bootstrap');
          return result(0);
        },
        runSetup: async () => {
          events.push('setup');
          return result(0);
        },
        showDoctorResult: () => events.push('show-doctor'),
        log: (message) => {
          events.push('explain-setup');
          explanations.push(message);
        },
      }),
    ).resolves.toBe('set-up');
    expect(events).toEqual([
      'probe',
      'doctor',
      'show-doctor',
      'explain-setup',
      'setup',
      'doctor',
      'show-doctor',
    ]);
    expect(explanations).toEqual([
      '未適用マイグレーションを順番に適用します。既存データは保持します。',
    ]);
  });

  it('does not prepare remote or production targets automatically', async () => {
    for (const scenario of [
      {
        settings: { appEnv: 'local', host: 'db.example.test', port: 3306 },
        output: 'DOCTOR_FAILED [ER_BAD_DB_ERROR]',
      },
      {
        settings: { appEnv: 'production', host: '127.0.0.1', port: 3306 },
        output: 'DOCTOR_FAILED [ER_ACCESS_DENIED_ERROR]',
      },
      {
        settings: { appEnv: 'local', host: 'db.example.test', port: 3306 },
        output: 'DOCTOR_FAILED [MINETENANT_MIGRATION_PENDING]',
      },
      {
        settings: { appEnv: 'production', host: '127.0.0.1', port: 3306 },
        output: 'DOCTOR_FAILED [MINETENANT_MIGRATION_PENDING]',
      },
    ]) {
      let bootstrapped = false;
      await expect(
        prepareDatabaseForDevelopment({
          settings: scenario.settings,
          probe: async () => {},
          runDoctor: async () => result(1, scenario.output),
          runBootstrap: async () => {
            bootstrapped = true;
            return result(0);
          },
          runSetup: async () => {
            bootstrapped = true;
            return result(0);
          },
        }),
      ).rejects.toThrow();
      expect(bootstrapped).toBe(false);
    }
  });

  it('stops before doctor and bootstrap when MySQL is not reachable', async () => {
    let diagnosed = false;
    let bootstrapped = false;
    await expect(
      prepareDatabaseForDevelopment({
        settings: { appEnv: 'local', host: '127.0.0.1', port: 3306 },
        probe: async () => {
          throw new Error('connection refused');
        },
        runDoctor: async () => {
          diagnosed = true;
          return result(0);
        },
        runBootstrap: async () => {
          bootstrapped = true;
          return result(0);
        },
        runSetup: async () => {
          bootstrapped = true;
          return result(0);
        },
      }),
    ).rejects.toThrow('MySQL 127.0.0.1:3306');
    expect(diagnosed).toBe(false);
    expect(bootstrapped).toBe(false);
  });
});
