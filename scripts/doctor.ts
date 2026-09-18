import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { readConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { formatErrorForLog, supportsNodeVersion } from '../src/diagnostics.js';
import {
  inspectMigrationStatus,
  migrations,
} from '../src/db/migrations/index.js';
import {
  DatabaseReadinessError,
  type DatabaseReadiness,
  inspectDatabaseReadiness,
  readinessActions,
  readinessProblems,
  REQUIRED_SCHEMA,
} from '../src/readiness.js';

export function formatDoctorReadinessFailure(
  readiness: DatabaseReadiness,
): string {
  const code = new DatabaseReadinessError(readiness).code;
  const problems = readinessProblems(readiness);
  const actions = readinessActions(readiness);
  return (
    `DOCTOR_FAILED [${code}] ${problems.join('\n')}` +
    `\n対処:\n- ${actions.join('\n- ')}`
  );
}

export async function runDoctor(): Promise<number> {
  if (!supportsNodeVersion(process.versions.node)) {
    console.error(
      `DOCTOR_FAILED Node.js ${process.versions.node} は未対応です。.nvmrc に合わせて Node.js 22.22.2 以上を使用してください。`,
    );
    return 1;
  }
  if (!existsSync('.env')) {
    console.error(
      'DOCTOR_FAILED .env がありません。npm run dev で初回準備を実行してください。',
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
    console.error(`DOCTOR_FAILED CONFIGURATION_ERROR ${detail}`);
    return 1;
  }

  const db = createDatabase(config);
  try {
    const readiness = await inspectDatabaseReadiness(db, config.dbDatabase);
    if (!readiness.versionSupported) {
      console.error(formatDoctorReadinessFailure(readiness));
      return 1;
    }
    const migrationStatus = await inspectMigrationStatus(db, migrations);
    if (migrationStatus.pendingVersions.length > 0) {
      console.error(
        `DOCTOR_FAILED [MINETENANT_MIGRATION_PENDING] 未適用のDB変更: ${migrationStatus.pendingVersions.join(', ')}`,
      );
      console.error(
        '対処:\n- ローカル環境では npm run dev でversion順に適用してください。',
      );
      return 1;
    }
    const problems = readinessProblems(readiness);
    if (problems.length > 0) {
      console.error(formatDoctorReadinessFailure(readiness));
      return 1;
    }

    const tableCount = Object.keys(REQUIRED_SCHEMA).length;
    console.log(`Node.js: ${process.version}`);
    console.log(`MySQL: ${readiness.version}`);
    console.log(
      `Database: ${config.dbHost}:${config.dbPort}/${readiness.database}`,
    );
    console.log(`Tables: ${tableCount}/${tableCount}`);
    console.log('診断OK。npm run dev でAPIを起動できます。');
    return 0;
  } catch (error) {
    console.error(formatErrorForLog('DOCTOR_FAILED', error, config));
    return 1;
  } finally {
    await db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runDoctor();
}
