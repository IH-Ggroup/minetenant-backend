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
          'DBをバックアップし、npm run doctor の結果と schema_migrations の履歴を確認してください。',
      };
    case 'MINETENANT_SCHEMA_MISMATCH':
      return {
        code,
        summary:
          '永続監査table・列・一意制約またはtriggerがAPIの要件と一致しません。',
        action:
          'DBをバックアップし、npm run doctor の結果と schema_migrations の履歴を確認してください。',
      };
    case 'MINETENANT_MIGRATION_PENDING':
      return {
        code,
        summary: '未適用のDBマイグレーションがあります。',
        action: 'APIを起動する前に npm run db:migrate を実行してください。',
      };
    case 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE':
      return {
        code,
        summary: 'ID列の移行を安全に続行できないDB状態です。',
        action:
          '書き込みを停止したままDBをバックアップし、列・制約・孤児行を確認してからfix-forwardしてください。',
      };
    case 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE':
      return {
        code,
        summary: '商品状態の移行を安全に続行できないDB状態です。',
        action:
          '書き込みを停止したままDBをバックアップしてください。ローカル環境は npm run db:bootstrap を実行し、それ以外はデータ不整合・TRIGGER権限・log_bin_trust_function_creators をDB管理者と確認してからfix-forwardしてください。',
      };
    case 'MINETENANT_AUTH_SCHEMA_MIGRATION_UNSAFE':
      return {
        code,
        summary: 'username認証の移行schemaを安全に続行できない状態です。',
        action:
          '書き込みを停止したままDBをバックアップし、schema_migrations の履歴と users の列・indexを確認してからfix-forwardしてください。',
      };
    case 'MINETENANT_DATABASE_UNSUPPORTED':
      return {
        code,
        summary: '対応していないデータベースサーバーです。',
        action:
          'MySQL 8.0.17以上を使用し、npm run doctor を再実行してください。',
      };
    case 'MINETENANT_DB_SESSION_INITIALIZATION_FAILED':
      return {
        code,
        summary: 'MySQL接続sessionの初期化に失敗しました。',
        action:
          "接続用ユーザーが SET SESSION time_zone = '+00:00' を実行できることとDB proxyの設定を確認し、npm run doctor を再実行してください。",
      };
    case 'MINETENANT_DB_SESSION_VERIFICATION_FAILED':
      return {
        code,
        summary: 'MySQL接続sessionの設定を確認できません。',
        action:
          '接続用ユーザーがsession変数を参照できることとDB proxyの設定を確認し、npm run doctor を再実行してください。',
      };
    case 'MINETENANT_DB_SESSION_STATE_INVALID':
      return {
        code,
        summary: 'MySQLから想定外のsession設定が返されました。',
        action:
          'MySQL 8.0.17以上に接続していることとDB proxyのsession変数の互換性を確認し、npm run doctor を再実行してください。',
      };
    case 'MINETENANT_DB_UTC_REQUIRED':
      return {
        code,
        summary: 'MySQL接続のtime zoneをUTCに固定できません。',
        action:
          "DB proxyを含む接続設定で SET SESSION time_zone = '+00:00' が保持されるように修正し、npm run doctor を再実行してください。",
      };
    case 'MINETENANT_DB_STRICT_MODE_REQUIRED':
      return {
        code,
        summary: 'MySQL接続でstrict SQL modeが有効ではありません。',
        action:
          '接続sessionの sql_mode に STRICT_TRANS_TABLES または STRICT_ALL_TABLES を追加し、npm run doctor を再実行してください。',
      };
    case 'MINETENANT_DB_TRANSACTION_COMMIT_FAILED':
      return {
        code,
        summary: 'DB transactionのcommit結果を確認できませんでした。',
        action:
          'DB接続を確認し、同じ操作を再送する前にrequestIdなどの結果照会手段で成立済みか確認してください。接続復旧後に npm run doctor を再実行してください。',
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
      if (code?.startsWith('MINETENANT_AUTH_BACKFILL_')) {
        return {
          code,
          summary:
            'username認証dataの移行前提または専用DB sessionの検証に失敗しました。',
          action:
            '書き込みを停止したままDBをバックアップし、docs/auth-cutover.md の診断手順に従ってください。',
        };
      }
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
