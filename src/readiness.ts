import type { Database } from './db.js';

export type ReadinessQuery = Pick<Database, 'query'>;

export const REQUIRED_SCHEMA = {
  users: [
    'id',
    'name',
    'email',
    'password',
    'role',
    'role_label',
    'avatar_initial',
    'created_at',
    'updated_at',
  ],
  stores: [
    'id',
    'owner_id',
    'name',
    'description',
    'level',
    'points',
    'sync_status',
    'created_at',
    'updated_at',
  ],
  products: [
    'id',
    'store_id',
    'seller_id',
    'name',
    'description',
    'price',
    'stock',
    'category',
    'theme',
    'emoji',
    'created_at',
    'updated_at',
  ],
  purchase_transactions: [
    'id',
    'request_id',
    'product_id',
    'buyer_id',
    'seller_id',
    'source',
    'amount',
    'status',
    'created_at',
    'updated_at',
  ],
  hono_sessions: ['id', 'user_id', 'csrf_token', 'expires_at'],
  hono_rate_limits: ['key_hash', 'hits', 'expires_at'],
} as const;

const REQUIRED_UNIQUE_KEYS = [
  { table: 'users', column: 'email' },
  { table: 'stores', column: 'owner_id' },
  { table: 'purchase_transactions', column: 'request_id' },
] as const;

export interface DatabaseReadiness {
  database: string;
  version: string;
  versionComment: string;
  versionSupported: boolean;
  missingTables: string[];
  missingColumns: string[];
  missingUniqueKeys: string[];
}

interface ServerMetadata {
  database: string;
  version: string;
  versionComment: string;
}

interface ColumnMetadata {
  tableName: string;
  columnName: string;
}

interface IndexMetadata {
  tableName: string;
  indexName: string;
  nonUnique: number;
  sequence: number;
  columnName: string;
}

export class DatabaseReadinessError extends Error {
  readonly code: string;

  constructor(readiness: DatabaseReadiness) {
    const unsupported = !readiness.versionSupported;
    super(
      unsupported
        ? 'The database server version is unsupported.'
        : 'The application database schema is incomplete.',
    );
    this.name = 'DatabaseReadinessError';
    this.code = unsupported
      ? 'MINETENANT_DATABASE_UNSUPPORTED'
      : readiness.missingColumns.length > 0 ||
          readiness.missingUniqueKeys.length > 0
        ? 'MINETENANT_SCHEMA_MISMATCH'
        : 'MINETENANT_SCHEMA_INCOMPLETE';
  }
}

export function assertAdditiveSchemaSafe(readiness: DatabaseReadiness): void {
  if (
    !readiness.versionSupported ||
    readiness.missingColumns.length > 0 ||
    readiness.missingUniqueKeys.length > 0
  ) {
    throw new DatabaseReadinessError(readiness);
  }
}

export function supportsMySqlVersion(
  version: string,
  versionComment = '',
): boolean {
  if (/mariadb/i.test(`${version} ${versionComment}`)) return false;
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major >= 8;
}

export function readinessProblems(readiness: DatabaseReadiness): string[] {
  const problems: string[] = [];
  if (!readiness.versionSupported) {
    problems.push(`未対応のDBサーバー: ${readiness.version}`);
  }
  if (readiness.missingTables.length > 0) {
    problems.push(`未作成のテーブル: ${readiness.missingTables.join(', ')}`);
  }
  if (readiness.missingColumns.length > 0) {
    problems.push(`不足している列: ${readiness.missingColumns.join(', ')}`);
  }
  if (readiness.missingUniqueKeys.length > 0) {
    problems.push(
      `不足している一意制約: ${readiness.missingUniqueKeys.join(', ')}`,
    );
  }
  return problems;
}

export function readinessActions(readiness: DatabaseReadiness): string[] {
  const actions: string[] = [];
  if (!readiness.versionSupported) {
    actions.push('MySQL 8.0以上へ切り替えてください。');
  }
  if (readiness.missingTables.length > 0) {
    actions.push(
      'ローカル環境では npm run dev で未作成テーブルを追加してください。',
    );
  }
  if (
    readiness.missingColumns.length > 0 ||
    readiness.missingUniqueKeys.length > 0
  ) {
    actions.push(
      '既存テーブルは自動変更しません。DBをバックアップし、不足項目用のスキーマ変更を作成・適用してください。',
    );
  }
  return actions;
}

export function evaluateDatabaseMetadata(
  expectedDatabase: string,
  server: ServerMetadata | undefined,
  columns: ColumnMetadata[],
  indexes: IndexMetadata[],
): DatabaseReadiness {
  const columnsByTable = new Map<string, Set<string>>();
  for (const column of columns) {
    const present = columnsByTable.get(column.tableName) ?? new Set<string>();
    present.add(column.columnName);
    columnsByTable.set(column.tableName, present);
  }

  const uniqueIndexes = new Map<string, string[]>();
  for (const index of indexes) {
    if (Number(index.nonUnique) !== 0) continue;
    const key = `${index.tableName}.${index.indexName}`;
    const present = uniqueIndexes.get(key) ?? [];
    present[index.sequence - 1] = index.columnName;
    uniqueIndexes.set(key, present);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    const present = columnsByTable.get(table);
    if (!present) {
      missingTables.push(table);
      continue;
    }
    for (const column of requiredColumns) {
      if (!present.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }

  const missingUniqueKeys = REQUIRED_UNIQUE_KEYS.filter(
    ({ table, column }) =>
      columnsByTable.has(table) &&
      [...uniqueIndexes.entries()].every(
        ([key, columnsInIndex]) =>
          !key.startsWith(`${table}.`) ||
          columnsInIndex.length !== 1 ||
          columnsInIndex[0] !== column,
      ),
  ).map(({ table, column }) => `${table}.${column}`);

  const version = server?.version ?? 'unknown';
  const versionComment = server?.versionComment ?? '';
  return {
    database: server?.database ?? expectedDatabase,
    version,
    versionComment,
    versionSupported: supportsMySqlVersion(version, versionComment),
    missingTables,
    missingColumns,
    missingUniqueKeys,
  };
}

export async function inspectDatabaseReadiness(
  db: ReadinessQuery,
  expectedDatabase: string,
): Promise<DatabaseReadiness> {
  const [server] = await db.query<ServerMetadata>(
    'SELECT DATABASE() AS `database`, VERSION() AS version, @@version_comment AS versionComment',
  );
  const columns = await db.query<ColumnMetadata>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.columns WHERE table_schema = ?`,
    [expectedDatabase],
  );
  const indexes = await db.query<IndexMetadata>(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
            NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
            COLUMN_NAME AS columnName
       FROM information_schema.statistics
      WHERE table_schema = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [expectedDatabase],
  );
  return evaluateDatabaseMetadata(expectedDatabase, server, columns, indexes);
}

export async function assertDatabaseReady(
  db: Database,
  expectedDatabase: string,
): Promise<DatabaseReadiness> {
  const readiness = await inspectDatabaseReadiness(db, expectedDatabase);
  if (readinessProblems(readiness).length > 0) {
    throw new DatabaseReadinessError(readiness);
  }
  return readiness;
}
