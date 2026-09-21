import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1']);
const BOOTSTRAP_DIAGNOSTIC_CODES = new Set([
  'ER_ACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR',
]);
const DEPENDENCY_SENTINEL = '.minetenant-package-lock.sha256';

export class PredevFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'PredevFailure';
  }
}

export function supportsNodeRuntime(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  const minimum = [22, 22, 2];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

function replaceEnvAssignment(contents, key, value) {
  const assignment = new RegExp(`^${key}=.*$`, 'm');
  if (!assignment.test(contents)) {
    throw new PredevFailure(`.env.example に ${key} がありません。`);
  }
  return contents.replace(assignment, `${key}=${value}`);
}

export function envWithUniqueDatabaseCredentials(
  template,
  createRandomBytes = randomBytes,
) {
  const username = `minetenant_dev_${createRandomBytes(6).toString('hex')}`;
  const password = createRandomBytes(24).toString('base64url');
  if (username.length > 32 || !/^[A-Za-z0-9_]+$/.test(username)) {
    throw new PredevFailure(
      '安全なローカルDBユーザー名を生成できませんでした。',
    );
  }
  return replaceEnvAssignment(
    replaceEnvAssignment(template, 'DB_USERNAME', username),
    'DB_PASSWORD',
    password,
  );
}

export async function ensureEnvFile(
  projectRoot,
  createRandomBytes = randomBytes,
) {
  const source = join(projectRoot, '.env.example');
  const target = join(projectRoot, '.env');
  try {
    const template = await readFile(source, 'utf8');
    const contents = envWithUniqueDatabaseCredentials(
      template,
      createRandomBytes,
    );
    await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
    return 'created';
  } catch (error) {
    if (error?.code === 'EEXIST') return 'preserved';
    throw new PredevFailure(
      '.env を作成できません。.env.example とファイル権限を確認してください。',
    );
  }
}

export function runtimeDependenciesPresent(
  projectRoot,
  pathExists = existsSync,
  platform = process.platform,
) {
  const executable = platform === 'win32' ? 'tsx.cmd' : 'tsx';
  return [
    join(projectRoot, 'node_modules', '.bin', executable),
    join(projectRoot, 'node_modules', '@hono', 'node-server', 'package.json'),
    join(projectRoot, 'node_modules', 'dotenv', 'package.json'),
    join(projectRoot, 'node_modules', 'hono', 'package.json'),
    join(projectRoot, 'node_modules', 'mysql2', 'package.json'),
  ].every((path) => pathExists(path));
}

export function packageLockDigest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export async function runtimeDependenciesCurrent(
  projectRoot,
  pathExists = existsSync,
  platform = process.platform,
) {
  if (!runtimeDependenciesPresent(projectRoot, pathExists, platform)) {
    return false;
  }
  try {
    const [packageLock, sentinel] = await Promise.all([
      readFile(join(projectRoot, 'package-lock.json')),
      readFile(join(projectRoot, 'node_modules', DEPENDENCY_SENTINEL), 'utf8'),
    ]);
    return sentinel.trim() === packageLockDigest(packageLock);
  } catch {
    return false;
  }
}

export async function writeDependencySentinel(projectRoot) {
  const packageLock = await readFile(join(projectRoot, 'package-lock.json'));
  await writeFile(
    join(projectRoot, 'node_modules', DEPENDENCY_SENTINEL),
    `${packageLockDigest(packageLock)}\n`,
    { flag: 'w' },
  );
}

function parseEnvValue(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\r', '\r')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\');
  }
  return value.replace(/\s+#.*$/, '').trim();
}

export function parseEnvFile(contents) {
  const parsed = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (match) parsed[match[1]] = parseEnvValue(match[2]);
  }
  return parsed;
}

export function readDatabaseSettings(contents, environment = {}) {
  const file = parseEnvFile(contents);
  const host = environment.DB_HOST ?? file.DB_HOST ?? '127.0.0.1';
  const portText = environment.DB_PORT ?? file.DB_PORT ?? '3306';
  const appEnv = environment.APP_ENV ?? file.APP_ENV ?? 'local';
  const port = Number(portText || '3306');
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new PredevFailure('.env の DB_HOST と DB_PORT を確認してください。');
  }
  return { appEnv, host, port };
}

export function isLocalDatabaseHost(host) {
  return LOCAL_DATABASE_HOSTS.has(host.toLowerCase());
}

export function doctorNeedsBootstrap(output) {
  const codes = output.matchAll(/\[([A-Z0-9_]+)\]/g);
  return [...codes].some((match) => BOOTSTRAP_DIAGNOSTIC_CODES.has(match[1]));
}

export function doctorNeedsSafeSetup(output) {
  return /\[MINETENANT_MIGRATION_PENDING\]/.test(output);
}

export function probeDatabasePort({ host, port }, timeoutMs = 2000) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) rejectProbe(error);
      else resolveProbe();
    };
    socket.once('connect', () => finish());
    socket.once('error', (error) => finish(error));
    socket.setTimeout(timeoutMs, () => {
      const error = new Error('Database connection timed out.');
      error.code = 'ETIMEDOUT';
      finish(error);
    });
  });
}

function commandSucceeded(result) {
  return !result.error && result.status === 0;
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export async function prepareDatabaseForDevelopment({
  settings,
  probe = probeDatabasePort,
  runDoctor,
  runBootstrap,
  runSetup,
  showDoctorResult = () => {},
  log = () => {},
}) {
  try {
    await probe(settings);
  } catch {
    throw new PredevFailure(
      `MySQL ${settings.host}:${settings.port} に接続できません。MySQL 8.0以上を起動してから npm run dev をもう一度実行してください。`,
    );
  }

  const firstDoctor = await runDoctor();
  showDoctorResult(firstDoctor);
  if (commandSucceeded(firstDoctor)) return 'ready';

  const output = combinedOutput(firstDoctor);
  if (doctorNeedsSafeSetup(output)) {
    if (settings.appEnv !== 'local' || !isLocalDatabaseHost(settings.host)) {
      throw new PredevFailure(
        '未適用マイグレーションの自動適用は APP_ENV=local の localhost / 127.0.0.1 専用です。既存DBの接続設定を確認してください。',
      );
    }
    log('未適用マイグレーションを順番に適用します。既存データは保持します。');
    const setup = await runSetup();
    if (!commandSucceeded(setup)) {
      throw new PredevFailure(
        '登録済みマイグレーションの適用に失敗しました。上のメッセージを確認してください。',
      );
    }
    const secondDoctor = await runDoctor();
    showDoctorResult(secondDoctor);
    if (!commandSucceeded(secondDoctor)) {
      throw new PredevFailure(
        'マイグレーション適用後のdoctorに失敗しました。上のメッセージを確認してください。',
      );
    }
    return 'set-up';
  }

  if (!doctorNeedsBootstrap(output)) {
    throw new PredevFailure(
      'doctor の診断を解消してから npm run dev をもう一度実行してください。',
    );
  }
  if (settings.appEnv !== 'local' || !isLocalDatabaseHost(settings.host)) {
    throw new PredevFailure(
      'DBの自動作成は APP_ENV=local の localhost / 127.0.0.1 専用です。既存DBの接続設定を確認してください。',
    );
  }

  log(
    '初回DB準備を開始します。既存データと既存ユーザーのパスワードは変更しません。',
  );
  const bootstrap = await runBootstrap();
  if (!commandSucceeded(bootstrap)) {
    throw new PredevFailure(
      'DBの初回準備に失敗しました。上のメッセージを確認してください。',
    );
  }

  const secondDoctor = await runDoctor();
  showDoctorResult(secondDoctor);
  if (!commandSucceeded(secondDoctor)) {
    throw new PredevFailure(
      'DB準備後のdoctorに失敗しました。上のメッセージを確認してください。',
    );
  }
  return 'bootstrapped';
}

export function npmInvocation(
  args,
  environment = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
) {
  if (environment.npm_execpath) {
    return {
      command: nodeExecutable,
      args: [environment.npm_execpath, ...args],
    };
  }
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
  };
}

function runNpm(projectRoot, args, capture = false) {
  const invocation = npmInvocation(args);
  return spawnSync(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: process.env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
  });
}

function showCapturedResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function main() {
  if (!supportsNodeRuntime(process.versions.node)) {
    throw new PredevFailure(
      `Node.js ${process.versions.node} は未対応です。.nvmrc に合わせて Node.js 22.22.2 以上を使用してください。`,
    );
  }
  const projectRoot = process.cwd();
  const envState = await ensureEnvFile(projectRoot);
  if (envState === 'created') console.log('.env を作成しました。');

  if (!(await runtimeDependenciesCurrent(projectRoot))) {
    console.log(
      '依存パッケージがないかpackage-lock.jsonと一致しないため npm ci を実行します。',
    );
    const install = runNpm(projectRoot, ['ci']);
    if (!commandSucceeded(install)) {
      throw new PredevFailure(
        'npm ci に失敗しました。Node.jsのバージョンと上のメッセージを確認してください。',
      );
    }
    await writeDependencySentinel(projectRoot);
  }

  const envContents = await readFile(join(projectRoot, '.env'), 'utf8');
  const settings = readDatabaseSettings(envContents, process.env);
  await prepareDatabaseForDevelopment({
    settings,
    runDoctor: () => runNpm(projectRoot, ['--silent', 'run', 'doctor'], true),
    runBootstrap: () =>
      runNpm(projectRoot, ['--silent', 'run', 'db:bootstrap']),
    runSetup: () => runNpm(projectRoot, ['--silent', 'run', 'setup']),
    showDoctorResult: showCapturedResult,
    log: console.log,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof PredevFailure
        ? error.message
        : '起動前の準備に失敗しました。';
    console.error(`PREDEV_FAILED ${message}`);
    process.exitCode = 1;
  }
}
