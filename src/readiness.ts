import type { Database } from './db.js';
import {
  PRODUCT_STATUS_AUDIT_REQUIRED_COLUMNS,
  PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS,
  type ProductStatusAuditTableContract,
} from './db/product-status-audit-contract.js';
import {
  PRODUCT_STATUS_TRIGGER_CONTRACTS,
  normalizeTriggerStatement,
  type TriggerContract,
} from './db/product-status-trigger-contract.js';

export type ReadinessQuery = Pick<Database, 'query'>;

export type UniqueKeyRequirement =
  | { table: string; column: string }
  | { table: string; columns: readonly string[] };

export interface SchemaRequirements {
  tables: Readonly<Record<string, readonly string[]>>;
  uniqueKeys: readonly UniqueKeyRequirement[];
  triggers?: readonly TriggerContract[];
  exactTables?: readonly ProductStatusAuditTableContract[];
}

export const INITIAL_SCHEMA_REQUIREMENTS = {
  tables: {
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
  },
  uniqueKeys: [
    { table: 'users', column: 'email' },
    { table: 'stores', column: 'owner_id' },
    { table: 'purchase_transactions', column: 'request_id' },
  ],
} as const satisfies SchemaRequirements;

/** Current application schema after 0002_product_status. */
export const CURRENT_SCHEMA_REQUIREMENTS = {
  tables: {
    users: [
      'user_id',
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
      'store_id',
      'user_id',
      'name',
      'description',
      'level',
      'points',
      'sync_status',
      'created_at',
      'updated_at',
    ],
    products: [
      'product_id',
      'store_id',
      'user_id',
      'name',
      'description',
      'price',
      'stock',
      'status',
      'category',
      'theme',
      'emoji',
      'listing_request_id',
      'listing_request_fingerprint',
      'deleted_at',
      'created_at',
      'updated_at',
    ],
    purchase_transactions: [
      'transaction_id',
      'request_id',
      'product_id',
      'buyer_user_id',
      'seller_user_id',
      'source',
      'amount',
      'status',
      'created_at',
      'updated_at',
    ],
    ...PRODUCT_STATUS_AUDIT_REQUIRED_COLUMNS,
    hono_sessions: ['session_id', 'user_id', 'csrf_token', 'expires_at'],
    hono_rate_limits: ['key_hash', 'hits', 'expires_at'],
  },
  uniqueKeys: [
    { table: 'users', column: 'email' },
    { table: 'stores', column: 'user_id' },
    {
      table: 'products',
      columns: ['user_id', 'listing_request_id'],
    },
    { table: 'products', columns: ['product_id', 'user_id'] },
    { table: 'purchase_transactions', column: 'request_id' },
    { table: 'purchase_transactions', column: 'product_id' },
    ...PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS.map(({ name, primaryKey }) => ({
      table: name,
      columns: primaryKey,
    })),
  ],
  triggers: PRODUCT_STATUS_TRIGGER_CONTRACTS,
  exactTables: PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS,
} as const satisfies SchemaRequirements;

export const REQUIRED_SCHEMA = {
  ...CURRENT_SCHEMA_REQUIREMENTS.tables,
  schema_migrations: ['version', 'applied_at'],
} as const;

const APPLICATION_SCHEMA_REQUIREMENTS: SchemaRequirements = {
  tables: REQUIRED_SCHEMA,
  uniqueKeys: [
    ...CURRENT_SCHEMA_REQUIREMENTS.uniqueKeys,
    { table: 'schema_migrations', column: 'version' },
  ],
  triggers: CURRENT_SCHEMA_REQUIREMENTS.triggers,
  exactTables: CURRENT_SCHEMA_REQUIREMENTS.exactTables,
};

const SERVER_ONLY_REQUIREMENTS: SchemaRequirements = {
  tables: {},
  uniqueKeys: [],
};

const PERSISTENT_MIGRATION_AUDIT_TABLES = new Set<string>(
  PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS.map(({ name }) => name),
);

export interface DatabaseReadiness {
  database: string;
  version: string;
  versionComment: string;
  versionSupported: boolean;
  missingTables: string[];
  missingColumns: string[];
  missingUniqueKeys: string[];
  invalidTables: string[];
  invalidTriggers: string[];
}

interface ServerMetadata {
  database: string;
  version: string;
  versionComment: string;
}

interface ColumnMetadata {
  tableName: string;
  columnName: string;
  columnType?: string;
  isNullable?: string;
  characterSetName?: string | null;
  collationName?: string | null;
  columnDefault?: string | null;
  extra?: string;
  generationExpression?: string | null;
}

interface IndexMetadata {
  tableName: string;
  indexName: string;
  nonUnique: number;
  sequence: number;
  columnName: string | null;
  isVisible?: string;
  expression?: string | null;
  subPart?: number | null;
  collation?: string | null;
  indexType?: string;
}

interface TableMetadata {
  tableName: string;
  engine: string | null;
  tableCollation: string | null;
}

interface TableConstraintMetadata {
  tableName: string;
  constraintName: string;
  constraintType: string;
}

interface TriggerMetadata {
  triggerName: string;
  eventObjectTable: string;
  eventManipulation: string;
  actionTiming: string;
  actionOrientation: string;
  actionStatement: string;
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
      : hasPersistentMigrationAuditDrift(readiness) ||
          readiness.missingColumns.length > 0 ||
          readiness.missingUniqueKeys.length > 0 ||
          readiness.invalidTables.length > 0 ||
          readiness.invalidTriggers.length > 0
        ? 'MINETENANT_SCHEMA_MISMATCH'
        : 'MINETENANT_SCHEMA_INCOMPLETE';
  }
}

export function assertAdditiveSchemaSafe(readiness: DatabaseReadiness): void {
  if (
    !readiness.versionSupported ||
    hasPersistentMigrationAuditDrift(readiness) ||
    readiness.missingColumns.length > 0 ||
    readiness.missingUniqueKeys.length > 0 ||
    readiness.invalidTables.length > 0 ||
    readiness.invalidTriggers.length > 0
  ) {
    throw new DatabaseReadinessError(readiness);
  }
}

function hasPersistentMigrationAuditDrift(
  readiness: DatabaseReadiness,
): boolean {
  const missingTables = new Set(readiness.missingTables);
  const applicationSchemaIsEmpty = Object.keys(REQUIRED_SCHEMA).every((table) =>
    missingTables.has(table),
  );
  return (
    !applicationSchemaIsEmpty &&
    readiness.missingTables.some((table) =>
      PERSISTENT_MIGRATION_AUDIT_TABLES.has(table),
    )
  );
}

export function supportsMySqlVersion(
  version: string,
  versionComment = '',
): boolean {
  if (/mariadb/i.test(`${version} ${versionComment}`)) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (
    major > 8 || (major === 8 && (minor > 0 || (minor === 0 && patch >= 17)))
  );
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
  if (readiness.invalidTables.length > 0) {
    problems.push(
      `定義不一致のテーブル: ${readiness.invalidTables.join(', ')}`,
    );
  }
  if (readiness.invalidTriggers.length > 0) {
    problems.push(
      `不足または定義不一致のtrigger: ${readiness.invalidTriggers.join(', ')}`,
    );
  }
  return problems;
}

export function readinessActions(readiness: DatabaseReadiness): string[] {
  const actions: string[] = [];
  if (!readiness.versionSupported) {
    actions.push('MySQL 8.0.17以上へ切り替えてください。');
  }
  if (readiness.missingTables.length > 0) {
    actions.push(
      'DBをバックアップし、schema_migrations の履歴と実際のテーブルを確認してください。',
    );
  }
  if (
    hasPersistentMigrationAuditDrift(readiness) ||
    readiness.missingColumns.length > 0 ||
    readiness.missingUniqueKeys.length > 0 ||
    readiness.invalidTables.length > 0 ||
    readiness.invalidTriggers.length > 0
  ) {
    actions.push(
      'DBをバックアップし、schema_migrations の履歴と不足または定義不一致の監査table・列・一意制約・triggerを確認してください。',
    );
  }
  return actions;
}

function exactTableDefinitionMatches(
  requirement: ProductStatusAuditTableContract,
  columns: readonly ColumnMetadata[],
  indexes: readonly IndexMetadata[],
  tables: readonly TableMetadata[],
  constraints: readonly TableConstraintMetadata[],
  triggers: readonly TriggerMetadata[],
): boolean {
  const table = tables.find(({ tableName }) => tableName === requirement.name);
  if (
    table?.engine?.toLowerCase() !== requirement.engine ||
    table.tableCollation?.toLowerCase() !== requirement.tableCollation
  ) {
    return false;
  }

  const tableColumns = columns.filter(
    ({ tableName }) => tableName === requirement.name,
  );
  if (tableColumns.length !== requirement.columns.length) return false;
  for (const expected of requirement.columns) {
    const actual = tableColumns.find(
      ({ columnName }) => columnName === expected.column,
    );
    if (
      actual?.columnType?.toLowerCase() !== expected.columnType ||
      actual.isNullable !== expected.nullable ||
      (actual.characterSetName?.toLowerCase() ?? null) !==
        expected.characterSet ||
      (actual.collationName?.toLowerCase() ?? null) !== expected.collation ||
      actual.columnDefault !== expected.defaultValue ||
      actual.extra?.trim() !== '' ||
      actual.generationExpression === undefined ||
      (actual.generationExpression?.trim().length ?? 0) > 0
    ) {
      return false;
    }
  }

  const tableIndexes = indexes.filter(
    ({ tableName }) => tableName === requirement.name,
  );
  const indexNames = new Set(tableIndexes.map(({ indexName }) => indexName));
  const primaryRows = tableIndexes
    .filter(({ indexName }) => indexName === 'PRIMARY')
    .toSorted((left, right) => left.sequence - right.sequence);
  if (
    indexNames.size !== 1 ||
    !indexNames.has('PRIMARY') ||
    primaryRows.length !== requirement.primaryKey.length ||
    primaryRows.some(
      (row, index) =>
        Number(row.nonUnique) !== 0 ||
        row.sequence !== index + 1 ||
        row.columnName !== requirement.primaryKey[index] ||
        row.isVisible?.toUpperCase() !== 'YES' ||
        row.expression !== null ||
        row.subPart !== null ||
        row.collation?.toUpperCase() !== 'A' ||
        row.indexType?.toUpperCase() !== 'BTREE',
    )
  ) {
    return false;
  }

  return (
    !constraints.some(({ tableName }) => tableName === requirement.name) &&
    !triggers.some(
      ({ eventObjectTable }) => eventObjectTable === requirement.name,
    )
  );
}

export function evaluateDatabaseMetadata(
  expectedDatabase: string,
  server: ServerMetadata | undefined,
  columns: ColumnMetadata[],
  indexes: IndexMetadata[],
  requirements: SchemaRequirements = APPLICATION_SCHEMA_REQUIREMENTS,
  triggers: TriggerMetadata[] = [],
  tables: TableMetadata[] = [],
  constraints: TableConstraintMetadata[] = [],
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
    if (index.columnName === null) continue;
    const key = `${index.tableName}.${index.indexName}`;
    const present = uniqueIndexes.get(key) ?? [];
    present[index.sequence - 1] = index.columnName;
    uniqueIndexes.set(key, present);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  for (const [table, requiredColumns] of Object.entries(requirements.tables)) {
    const present = columnsByTable.get(table);
    if (!present) {
      missingTables.push(table);
      continue;
    }
    for (const column of requiredColumns) {
      if (!present.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }

  const missingUniqueKeys = requirements.uniqueKeys
    .filter((requirement) => {
      if (!columnsByTable.has(requirement.table)) return false;
      const requiredColumns =
        'columns' in requirement ? requirement.columns : [requirement.column];
      return [...uniqueIndexes.entries()].every(
        ([key, columnsInIndex]) =>
          !key.startsWith(`${requirement.table}.`) ||
          columnsInIndex.length !== requiredColumns.length ||
          requiredColumns.some(
            (column, index) => column !== columnsInIndex[index],
          ),
      );
    })
    .map((requirement) => {
      const requiredColumns =
        'columns' in requirement ? requirement.columns : [requirement.column];
      return requiredColumns.length === 1
        ? `${requirement.table}.${requiredColumns[0]}`
        : `${requirement.table}.(${requiredColumns.join(',')})`;
    });

  const invalidTables = (requirements.exactTables ?? [])
    .filter(
      (requirement) =>
        columnsByTable.has(requirement.name) &&
        !exactTableDefinitionMatches(
          requirement,
          columns,
          indexes,
          tables,
          constraints,
          triggers,
        ),
    )
    .map(({ name }) => name);

  const triggerRequirements = requirements.triggers ?? [];
  const requiredTriggerNames = new Set(
    triggerRequirements.map(({ name }) => name),
  );
  const triggerTables = new Set(triggerRequirements.map(({ table }) => table));
  const invalidRequiredTriggers = triggerRequirements
    .filter((requirement) => {
      if (!columnsByTable.has(requirement.table)) return false;
      const actual = triggers.find(
        ({ triggerName }) => triggerName === requirement.name,
      );
      return (
        actual === undefined ||
        actual.eventObjectTable !== requirement.table ||
        actual.eventManipulation !== requirement.event ||
        actual.actionTiming !== requirement.timing ||
        actual.actionOrientation !== requirement.orientation ||
        normalizeTriggerStatement(actual.actionStatement) !==
          normalizeTriggerStatement(requirement.statement)
      );
    })
    .map(({ name }) => name);
  const unexpectedTriggers = triggers
    .filter(
      ({ eventObjectTable, triggerName }) =>
        triggerTables.has(eventObjectTable) &&
        !requiredTriggerNames.has(triggerName),
    )
    .map(({ triggerName }) => triggerName)
    .toSorted();
  const invalidTriggers = [...invalidRequiredTriggers, ...unexpectedTriggers];

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
    invalidTables,
    invalidTriggers,
  };
}

export async function inspectDatabaseReadiness(
  db: ReadinessQuery,
  expectedDatabase: string,
  requirements: SchemaRequirements = APPLICATION_SCHEMA_REQUIREMENTS,
): Promise<DatabaseReadiness> {
  const [server] = await db.query<ServerMetadata>(
    'SELECT DATABASE() AS `database`, VERSION() AS version, @@version_comment AS versionComment',
  );
  const columns = await db.query<ColumnMetadata>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
            COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
            CHARACTER_SET_NAME AS characterSetName,
            COLLATION_NAME AS collationName, COLUMN_DEFAULT AS columnDefault,
            EXTRA AS extra, GENERATION_EXPRESSION AS generationExpression
       FROM information_schema.columns WHERE table_schema = ?`,
    [expectedDatabase],
  );
  const indexes = await db.query<IndexMetadata>(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
            NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
            COLUMN_NAME AS columnName, IS_VISIBLE AS isVisible,
            EXPRESSION AS expression, SUB_PART AS subPart,
            COLLATION AS collation, INDEX_TYPE AS indexType
       FROM information_schema.statistics
      WHERE table_schema = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [expectedDatabase],
  );
  const exactTableNames =
    requirements.exactTables?.map(({ name }) => name) ?? [];
  const exactTablePlaceholders = exactTableNames.map(() => '?').join(', ');
  const tables =
    exactTableNames.length === 0
      ? []
      : await db.query<TableMetadata>(
          `SELECT TABLE_NAME AS tableName, ENGINE AS engine,
                  TABLE_COLLATION AS tableCollation
             FROM information_schema.tables
            WHERE table_schema = ?
              AND table_name IN (${exactTablePlaceholders})`,
          [expectedDatabase, ...exactTableNames],
        );
  const constraints =
    exactTableNames.length === 0
      ? []
      : await db.query<TableConstraintMetadata>(
          `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
                  CONSTRAINT_TYPE AS constraintType
             FROM information_schema.table_constraints
            WHERE constraint_schema = ?
              AND table_name IN (${exactTablePlaceholders})
              AND constraint_type IN ('FOREIGN KEY', 'CHECK')`,
          [expectedDatabase, ...exactTableNames],
        );
  const triggers =
    (requirements.triggers?.length ?? 0) === 0 && exactTableNames.length === 0
      ? []
      : await db.query<TriggerMetadata>(
          `SELECT TRIGGER_NAME AS triggerName,
                  EVENT_OBJECT_TABLE AS eventObjectTable,
                  EVENT_MANIPULATION AS eventManipulation,
                  ACTION_TIMING AS actionTiming,
                  ACTION_ORIENTATION AS actionOrientation,
                  ACTION_STATEMENT AS actionStatement
             FROM information_schema.triggers
            WHERE trigger_schema = ?
            ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`,
          [expectedDatabase],
        );
  return evaluateDatabaseMetadata(
    expectedDatabase,
    server,
    columns,
    indexes,
    requirements,
    triggers,
    tables,
    constraints,
  );
}

export async function assertDatabaseReady(
  db: ReadinessQuery,
  expectedDatabase: string,
): Promise<DatabaseReadiness> {
  const readiness = await inspectDatabaseReadiness(db, expectedDatabase);
  if (readinessProblems(readiness).length > 0) {
    throw new DatabaseReadinessError(readiness);
  }
  return readiness;
}

export async function assertDatabaseServerSupported(
  db: ReadinessQuery,
  expectedDatabase: string,
): Promise<DatabaseReadiness> {
  const readiness = await inspectDatabaseReadiness(
    db,
    expectedDatabase,
    SERVER_ONLY_REQUIREMENTS,
  );
  if (!readiness.versionSupported) {
    throw new DatabaseReadinessError(readiness);
  }
  return readiness;
}
