import type { AppConfig } from './config.js';

type ErrorWithCode = Error & {
  code?: string;
  errno?: number;
  sqlState?: string;
};

export interface DatabaseDiagnostic {
  code: string;
  summary: string;
  action: string;
  includeDatabaseTarget?: boolean;
}

export function supportsNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  const minimum = [22, 22, 2];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  const code = (error as ErrorWithCode).code;
  return typeof code === 'string' ? code : undefined;
}

export function databaseDiagnostic(
  error: unknown,
): DatabaseDiagnostic | undefined {
  const code = errorCode(error);
  switch (code) {
    case 'ECONNREFUSED':
      return {
        code,
        summary:
          'MySQLに接続できません。MySQLが停止しているか、接続先が違います。',
        action:
          'MySQLを起動し、.env の DB_HOST と DB_PORT を確認してから再実行してください。',
      };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        code,
        summary: '.env の DB_HOST を名前解決できません。',
        action:
          'DB_HOST を確認してください。ローカル開発の初期値は 127.0.0.1 です。',
      };
    case 'ETIMEDOUT':
      return {
        code,
        summary: 'MySQLへの接続がタイムアウトしました。',
        action:
          'MySQLの起動状態、DB_HOST、DB_PORT、ファイアウォールを確認してください。',
      };
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_DBACCESS_DENIED_ERROR':
      return {
        code,
        summary:
          'MySQLのユーザーが未作成か、ユーザー名・パスワードが一致しません。',
        action:
          '初回セットアップは npm run dev が自動で行います。既存の .env を使う場合は DB_USERNAME と DB_PASSWORD を確認してください。',
      };
    case 'ER_BAD_DB_ERROR':
      return {
        code,
        summary: '.env で指定したMySQLデータベースがまだありません。',
        action:
          'npm run dev でデータベースと接続用ユーザーを自動準備してください。',
      };
    case 'MINETENANT_SCHEMA_INCOMPLETE':
      return {
        code,
        summary: 'APIに必要なテーブルが不足しています。',
        action:
          'ローカル環境では npm run dev が不足テーブルを安全に追加し、再診断します。',
      };
    case 'MINETENANT_SCHEMA_MISMATCH':
      return {
        code,
        summary: '既存テーブルの列または一意制約がAPIの要件と一致しません。',
        action:
          'npm run doctor で不足項目を確認してください。既存テーブルは自動変更しないため、DBをバックアップしてから不足項目用のスキーマ変更を適用してください。',
      };
    case 'MINETENANT_DATABASE_UNSUPPORTED':
      return {
        code,
        summary: '対応していないデータベースサーバーです。',
        action: 'MySQL 8.0以上を使用し、npm run doctor を再実行してください。',
      };
    case 'EADDRINUSE':
      return {
        code,
        summary: 'APIの待受ポートが既に使われています。',
        action:
          '既存のAPIプロセスを停止するか、PORTを別の空きポートへ変更してください。',
        includeDatabaseTarget: false,
      };
    default:
      return undefined;
  }
}

/**
 * Keep diagnostics useful without printing SQL, passwords, hashes, cookies or
 * tokens. The connection target and user are configuration, never secrets.
 */
export function formatErrorForLog(
  context: string,
  error: unknown,
  config: AppConfig,
): string {
  const diagnostic = databaseDiagnostic(error);
  if (diagnostic) {
    const lines = [`${context} [${diagnostic.code}] ${diagnostic.summary}`];
    if (diagnostic.includeDatabaseTarget !== false) {
      lines.push(
        `接続先: ${config.dbHost}:${config.dbPort}/${config.dbDatabase} (user: ${config.dbUsername})`,
      );
    }
    lines.push(`対処: ${diagnostic.action}`);
    return lines.join('\n');
  }

  const name = error instanceof Error ? error.name : 'UnknownError';
  const code = errorCode(error);
  return `${context}${code ? ` [${code}]` : ''} ${name}`;
}
