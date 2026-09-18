import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db.js';
import { migrations, runMigrations } from '../src/db/migrations/index.js';

export async function migrate(db: Database): Promise<void> {
  await runMigrations(db, migrations);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const db = createDatabase(readConfig());
  try {
    await migrate(db);
    console.log('Hono schema ready. Existing data preserved.');
  } finally {
    await db.close();
  }
}
