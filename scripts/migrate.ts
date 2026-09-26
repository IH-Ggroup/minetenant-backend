import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { readConfig, type AppConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db.js';
import { migrations, runMigrations } from '../src/db/migrations/index.js';
import { formatErrorForLog } from '../src/diagnostics.js';

export async function migrate(db: Database): Promise<void> {
  await runMigrations(db, migrations);
}

export function formatMigrationError(
  error: unknown,
  config: AppConfig,
): string {
  return formatErrorForLog('MIGRATION_FAILED', error, config);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = readConfig();
  const db = createDatabase(config);
  try {
    await migrate(db);
    console.log('Hono schema ready. Existing data preserved.');
  } catch (error) {
    console.error(formatMigrationError(error, config));
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
