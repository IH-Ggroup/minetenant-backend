import { existsSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';
import mysql, { type Connection } from 'mysql2/promise';
import { readConfig, type AppConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { formatErrorForLog } from '../src/diagnostics.js';
import {
  assertAdditiveSchemaSafe,
  inspectDatabaseReadiness,
  type ReadinessQuery,
} from '../src/readiness.js';
import { migrate } from './migrate.js';
import { seedDemo } from './seed.js';

const TEST_DATABASES = ['minetenant_test'] as const;
const LOCAL_USER_HOSTS = ['localhost', '127.0.0.1'] as const;
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1']);
type ApplicationUserHost = (typeof LOCAL_USER_HOSTS)[number] | '%';
const SYSTEM_DATABASES = new Set([
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
]);

class BootstrapFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapFailure';
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function requireEnvFile(): void {
  if (!existsSync('.env')) {
    throw new BootstrapFailure(
      '.env がありません。npm run dev でclone専用の安全な接続情報を作成してください。',
    );
  }
}

export function quoteDatabaseName(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new BootstrapFailure(
      'DB_DATABASE may only contain letters, numbers and underscores during local bootstrap.',
    );
  }
  return `\`${name}\``;
}

export function assertSafeBootstrapTarget(config: AppConfig): void {
  if (!LOCAL_DATABASE_HOSTS.has(config.dbHost.toLowerCase())) {
    throw new BootstrapFailure(
      'db:bootstrap may only connect to MySQL on localhost or 127.0.0.1.',
    );
  }
  if (SYSTEM_DATABASES.has(config.dbDatabase.toLowerCase())) {
    throw new BootstrapFailure(
      'db:bootstrap cannot use a MySQL system database.',
    );
  }
  if (
    TEST_DATABASES.some(
      (database) => database.toLowerCase() === config.dbDatabase.toLowerCase(),
    )
  ) {
    throw new BootstrapFailure(
      'DB_DATABASE must not use the reserved minetenant_test database.',
    );
  }
  if (!config.dbUsername.trim()) {
    throw new BootstrapFailure('DB_USERNAME must not be empty.');
  }
  if (!config.dbPassword.trim()) {
    throw new BootstrapFailure('DB_PASSWORD must not be empty.');
  }
}

export function readApplicationUserHosts(
  environment: NodeJS.ProcessEnv,
): ApplicationUserHost[] {
  const configured = environment.DB_BOOTSTRAP_USER_HOSTS;
  if (!configured) return [...LOCAL_USER_HOSTS];
  const hosts = [...new Set(configured.split(',').map((host) => host.trim()))];
  if (
    hosts.length === 0 ||
    hosts.some(
      (host) =>
        ![...LOCAL_USER_HOSTS, '%'].includes(host as ApplicationUserHost),
    )
  ) {
    throw new BootstrapFailure(
      'DB_BOOTSTRAP_USER_HOSTS only accepts localhost, 127.0.0.1 or %.',
    );
  }
  if (hosts.includes('%') && environment.CI !== 'true') {
    throw new BootstrapFailure(
      'The % application-user host is only allowed in CI.',
    );
  }
  return hosts as ApplicationUserHost[];
}

function readinessQuery(connection: Connection): ReadinessQuery {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const [rows] = await connection.query(sql, params);
      return rows as T[];
    },
  };
}

async function readHidden(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new BootstrapFailure(
      'MYSQL_ADMIN_PASSWORD is required when db:bootstrap is run without an interactive terminal.',
    );
  }

  stdout.write(question);
  const previousRawMode = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(previousRawMode);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          finish(new BootstrapFailure('MySQL bootstrap cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function createAccount(
  connection: Connection,
  config: AppConfig,
  host: ApplicationUserHost,
  resetPassword: boolean,
): Promise<void> {
  await connection.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?', [
    config.dbUsername,
    host,
    config.dbPassword,
  ]);
  if (resetPassword) {
    await connection.query('ALTER USER ?@? IDENTIFIED BY ?', [
      config.dbUsername,
      host,
      config.dbPassword,
    ]);
  }

  for (const database of [config.dbDatabase, ...TEST_DATABASES]) {
    await connection.query(
      `GRANT ALL PRIVILEGES ON ${quoteDatabaseName(database)}.* TO ?@?`,
      [config.dbUsername, host],
    );
  }
}

export async function provisionLocalDatabase(
  config: AppConfig,
  options: {
    adminUser: string;
    adminPassword: string;
    resetPassword?: boolean;
    userHosts?: readonly ApplicationUserHost[];
  },
): Promise<void> {
  if (config.appEnv !== 'local')
    throw new BootstrapFailure('db:bootstrap is for APP_ENV=local only.');
  assertSafeBootstrapTarget(config);
  if (config.dbUsername === options.adminUser) {
    throw new BootstrapFailure(
      'Use a dedicated DB_USERNAME for the application instead of the MySQL administrator account.',
    );
  }

  let connection: Connection;
  try {
    connection = await mysql.createConnection({
      host: config.dbHost,
      port: config.dbPort,
      user: options.adminUser,
      password: options.adminPassword,
      charset: 'utf8mb4_unicode_ci',
      timezone: 'Z',
    });
  } catch (error) {
    if (hasCode(error, 'ER_ACCESS_DENIED_ERROR')) {
      throw new BootstrapFailure(
        `MySQL管理ユーザー ${options.adminUser} でログインできません。管理ユーザー名と入力したパスワードを確認してください。`,
      );
    }
    throw error;
  }
  try {
    const readiness = await inspectDatabaseReadiness(
      readinessQuery(connection),
      config.dbDatabase,
    );
    assertAdditiveSchemaSafe(readiness);

    for (const database of [config.dbDatabase, ...TEST_DATABASES]) {
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS ${quoteDatabaseName(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    }
    for (const host of options.userHosts ?? LOCAL_USER_HOSTS) {
      await createAccount(
        connection,
        config,
        host,
        options.resetPassword === true,
      );
    }
  } catch (error) {
    if (
      hasCode(error, 'ER_ACCESS_DENIED_ERROR') ||
      hasCode(error, 'ER_DBACCESS_DENIED_ERROR')
    ) {
      throw new BootstrapFailure(
        `MySQL管理ユーザー ${options.adminUser} にDB・ユーザーを作成する権限がありません。権限のある管理ユーザーを指定してください。`,
      );
    }
    throw error;
  } finally {
    await connection.end();
  }
}

async function run(): Promise<void> {
  requireEnvFile();
  loadEnv({ path: '.env', quiet: true });
  const config = readConfig();
  assertSafeBootstrapTarget(config);
  const userHosts = readApplicationUserHosts(process.env);
  const adminUser = process.env.MYSQL_ADMIN_USER ?? 'root';
  const adminPassword =
    process.env.MYSQL_ADMIN_PASSWORD ??
    (await readHidden(`MySQL管理ユーザー ${adminUser} のパスワード: `));
  const resetPassword = process.argv.includes('--reset-app-password');

  console.log(
    `${config.dbHost}:${config.dbPort} に開発用DBとユーザーを準備します。`,
  );
  await provisionLocalDatabase(config, {
    adminUser,
    adminPassword,
    resetPassword,
    userHosts,
  });

  const db = createDatabase(config);
  try {
    try {
      await migrate(db);
    } catch (error) {
      if (hasCode(error, 'ER_ACCESS_DENIED_ERROR') && !resetPassword) {
        throw new BootstrapFailure(
          '既存のアプリ接続用ユーザーのパスワードは変更していません。.env を既存値に合わせるか、変更してよい場合だけ npm run db:bootstrap -- --reset-app-password を実行してください。',
        );
      }
      throw error;
    }
    const seeded = await seedDemo(db, config.bcryptRounds);
    console.log(
      seeded ? '初期データを作成しました。' : '既存データを保持しました。',
    );
    console.log('DB準備完了。npm run doctor で状態を確認できます。');
  } finally {
    await db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await run();
  } catch (error) {
    let config: AppConfig | undefined;
    try {
      config = readConfig();
    } catch {
      // The configuration error itself is more useful than a second error.
    }
    if (error instanceof BootstrapFailure) {
      console.error(`DB_BOOTSTRAP_FAILED ${error.message}`);
    } else {
      console.error(
        config
          ? formatErrorForLog('DB_BOOTSTRAP_FAILED', error, config)
          : `DB_BOOTSTRAP_FAILED ${error instanceof Error ? error.message : 'UnknownError'}`,
      );
    }
    process.exitCode = 1;
  }
}
