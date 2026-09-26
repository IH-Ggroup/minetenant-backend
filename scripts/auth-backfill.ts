import 'dotenv/config';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db.js';
import {
  AuthBackfillDataError,
  AuthBackfillError,
  countAuthBackfillViolations,
  runAuthBackfill,
  type AuthBackfillMode,
  type AuthBackfillViolation,
} from '../src/db/auth-backfill.js';
import { AuthSchemaMigrationError } from '../src/db/auth-schema.js';

export interface AuthBackfillCliOptions {
  mode: AuthBackfillMode;
  reportFile?: string;
}

function argumentError(message: string): never {
  throw new AuthBackfillError(
    'MINETENANT_AUTH_BACKFILL_ARGUMENT_INVALID',
    message,
  );
}

export function parseAuthBackfillArguments(
  args: readonly string[],
): AuthBackfillCliOptions {
  let mode: AuthBackfillMode | undefined;
  let reportFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    let key: '--mode' | '--report-file';
    let value: string | undefined;
    if (argument === '--mode' || argument === '--report-file') {
      key = argument;
      value = args[index + 1];
      index += 1;
    } else if (argument.startsWith('--mode=')) {
      key = '--mode';
      value = argument.slice('--mode='.length);
    } else if (argument.startsWith('--report-file=')) {
      key = '--report-file';
      value = argument.slice('--report-file='.length);
    } else {
      argumentError('Only --mode and --report-file are supported.');
    }
    if (!value || value.startsWith('--')) {
      argumentError(`${key} requires a value.`);
    }
    if (key === '--mode') {
      if (mode !== undefined)
        argumentError('--mode may only be specified once.');
      if (value !== 'check' && value !== 'apply') {
        argumentError('--mode must be check or apply.');
      }
      mode = value;
    } else {
      if (reportFile !== undefined) {
        argumentError('--report-file may only be specified once.');
      }
      if (!isAbsolute(value)) {
        argumentError('--report-file must be an absolute path.');
      }
      reportFile = value;
    }
  }
  return { mode: mode ?? 'check', ...(reportFile ? { reportFile } : {}) };
}

export async function writeAuthBackfillReport(
  path: string,
  violations: readonly AuthBackfillViolation[],
): Promise<void> {
  if (!isAbsolute(path))
    argumentError('--report-file must be an absolute path.');
  const ordered = [...violations].sort((left, right) => {
    const userOrder = Buffer.compare(
      Buffer.from(left.userId, 'utf8'),
      Buffer.from(right.userId, 'utf8'),
    );
    return (
      userOrder || left.violationCode.localeCompare(right.violationCode, 'en')
    );
  });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    const contents = ordered
      .map(({ userId, violationCode }) =>
        JSON.stringify({ userId, violationCode }),
      )
      .join('\n');
    await handle.writeFile(contents.length > 0 ? `${contents}\n` : '', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function authBackfillErrorCode(error: unknown): string {
  return error instanceof AuthBackfillError ||
    error instanceof AuthSchemaMigrationError
    ? error.code
    : 'MINETENANT_AUTH_BACKFILL_UNEXPECTED';
}

export async function executeAuthBackfill(
  database: Database,
  options: AuthBackfillCliOptions,
): Promise<void> {
  try {
    const result = await runAuthBackfill(database, options.mode);
    console.log(
      `Auth backfill ${result.mode} succeeded: total=${result.totalRows} planned=${result.plannedUpdateRows} updated=${result.updatedRows} violations=0`,
    );
  } catch (error) {
    if (error instanceof AuthBackfillDataError) {
      if (options.reportFile) {
        await writeAuthBackfillReport(options.reportFile, error.violations);
      }
      console.error(
        `Auth backfill ${options.mode} failed: total=${error.totalRows} planned=${error.plannedUpdateRows} violationCounts=${JSON.stringify(countAuthBackfillViolations(error.violations))}`,
      );
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseAuthBackfillArguments(process.argv.slice(2));
  const database = createDatabase(readConfig());
  try {
    await executeAuthBackfill(database, options);
  } finally {
    await database.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(
      `Auth backfill exited non-zero: ${authBackfillErrorCode(error)}.`,
    );
    process.exitCode = 1;
  });
}
