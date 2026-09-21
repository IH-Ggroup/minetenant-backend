import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createDatabase } from './db.js';
import { assertMigrationsCurrent, migrations } from './db/migrations/index.js';
import { formatErrorForLog } from './diagnostics.js';
import {
  assertDatabaseReady,
  assertDatabaseServerSupported,
} from './readiness.js';

async function start(): Promise<void> {
  let config;
  try {
    config = readConfig();
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : '設定を確認してください。';
    console.error(`API_STARTUP_FAILED CONFIGURATION_ERROR ${detail}`);
    process.exitCode = 1;
    return;
  }

  const db = createDatabase(config);
  try {
    await assertDatabaseServerSupported(db, config.dbDatabase);
    await assertMigrationsCurrent(db, migrations);
    await assertDatabaseReady(db, config.dbDatabase);
  } catch (error) {
    console.error(formatErrorForLog('API_STARTUP_FAILED', error, config));
    await db.close();
    process.exitCode = 1;
    return;
  }

  const app = createApp({ db, config });
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    () => {
      console.log(`MineTenant Hono API: http://${config.host}:${config.port}`);
    },
  );

  let stopping = false;
  server.once('error', (error) => {
    if (stopping) return;
    stopping = true;
    console.error(formatErrorForLog('API_STARTUP_FAILED', error, config));
    void db.close().finally(() => {
      process.exitCode = 1;
    });
  });

  function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void db.close().then(() => process.exit(0));
    });
    setTimeout(() => {
      if ('closeAllConnections' in server) server.closeAllConnections();
      process.exit(1);
    }, 10_000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await start();
