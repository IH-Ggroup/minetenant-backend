import { config as loadEnv } from 'dotenv';
import mysql from 'mysql2/promise';
import { readConfig } from '../src/config.js';

async function run(): Promise<void> {
  if (process.env.CI !== 'true') {
    throw new Error('configure-ci-mysql may only run with CI=true.');
  }
  loadEnv({ path: '.env', quiet: true });
  const config = readConfig();
  if (!['localhost', '127.0.0.1'].includes(config.dbHost.toLowerCase())) {
    throw new Error('CI MySQL configuration is restricted to loopback.');
  }
  const adminPassword = process.env.MYSQL_ADMIN_PASSWORD;
  if (adminPassword === undefined) {
    throw new Error('MYSQL_ADMIN_PASSWORD is required in CI.');
  }

  const connection = await mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: process.env.MYSQL_ADMIN_USER ?? 'root',
    password: adminPassword,
  });
  try {
    await connection.query('SET GLOBAL log_bin_trust_function_creators = 1');
    console.log('CI MySQL trigger support enabled.');
  } finally {
    await connection.end();
  }
}

try {
  await run();
} catch (error) {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? ` [${error.code}]`
      : '';
  const name = error instanceof Error ? error.name : 'UnknownError';
  console.error(`CI_MYSQL_FAILED${code} ${name}`);
  process.exitCode = 1;
}
