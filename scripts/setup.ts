import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { readConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { formatErrorForLog } from '../src/diagnostics.js';
import { assertDatabaseReady } from '../src/readiness.js';
import { migrate } from './migrate.js';
import { seedDemo } from './seed.js';

async function runSetup(): Promise<number> {
  if (!existsSync('.env')) {
    console.error(
      'SETUP_FAILED .env がありません。npm run dev でclone専用の安全な接続情報を作成してください。',
    );
    return 1;
  }

  loadEnv({ path: '.env', quiet: true });
  let config;
  try {
    config = readConfig();
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : '設定を確認してください。';
    console.error(`SETUP_FAILED CONFIGURATION_ERROR ${detail}`);
    return 1;
  }
  if (config.appEnv !== 'local') {
    console.error('SETUP_FAILED npm run setup is for APP_ENV=local only.');
    return 1;
  }

  const db = createDatabase(config);
  try {
    await migrate(db);
    await assertDatabaseReady(db, config.dbDatabase);
    const seeded = await seedDemo(db, config.bcryptRounds);
    console.log(
      seeded ? '初期データを作成しました。' : '既存データを保持しました。',
    );
    console.log('準備完了。npm run doctor で状態を確認してください。');
    return 0;
  } catch (error) {
    console.error(formatErrorForLog('SETUP_FAILED', error, config));
    return 1;
  } finally {
    await db.close();
  }
}

process.exitCode = await runSetup();
