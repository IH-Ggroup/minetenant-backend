import { copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { createDatabase } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { migrate } from './migrate.js';
import { seedDemo } from './seed.js';

try {
  await copyFile('.env.example', '.env', constants.COPYFILE_EXCL);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}
loadEnv({ quiet: true });
const config = readConfig();
if (config.appEnv !== 'local')
  throw new Error('npm run setup is for APP_ENV=local only.');
const db = createDatabase(config);
try {
  await migrate(db);
  const seeded = await seedDemo(db, config.bcryptRounds);
  console.log(
    seeded ? '初期データを作成しました。' : '既存データを保持しました。',
  );
  console.log('準備完了。npm run dev でAPIを起動してください。');
} finally {
  await db.close();
}
