import type { MigrationExecutor } from '../../db.js';
import {
  DatabaseReadinessError,
  inspectDatabaseReadiness,
  readinessProblems,
  type SchemaRequirements,
} from '../../readiness.js';
import type { Migration } from './types.js';

const FINAL_STAGE = 13;

// Keep this migration's historical verification contract independent from the
// application's evolving current-schema requirements.
export const ENTITY_ID_SCHEMA_REQUIREMENTS = {
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
      'category',
      'theme',
      'emoji',
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
    hono_sessions: ['session_id', 'user_id', 'csrf_token', 'expires_at'],
    hono_rate_limits: ['key_hash', 'hits', 'expires_at'],
  },
  uniqueKeys: [
    { table: 'users', column: 'email' },
    { table: 'stores', column: 'user_id' },
    { table: 'purchase_transactions', column: 'request_id' },
  ],
} as const satisfies SchemaRequirements;

type ColumnPhase = 'legacy' | 'final';
type ObjectPhase = 'legacy' | 'missing' | 'final';

interface ColumnRow {
  tableName: string;
  columnName: string;
  columnType: string;
  isNullable: 'YES' | 'NO';
  characterSetName: string | null;
  collationName: string | null;
  columnDefault: string | null;
  extra: string;
  generationExpression: string | null;
}

interface IndexRow {
  tableName: string;
  indexName: string;
  nonUnique: number;
  sequence: number;
  columnName: string | null;
  isVisible: string;
  expression: string | null;
  subPart: number | null;
  collation: string | null;
  indexType: string;
}

interface TableRow {
  tableName: string;
  engine: string | null;
}

interface ForeignKeyRow {
  constraintSchema: string;
  tableSchema: string;
  tableName: string;
  constraintName: string;
  columnName: string;
  referencedTableSchema: string;
  referencedTableName: string;
  referencedColumnName: string;
  sequence: number;
  deleteRule: string;
  updateRule: string;
}

interface SchemaObjectRow {
  objectName: string;
}

interface PartitionRow {
  tableName: string;
  partitionMethod: string | null;
  subpartitionMethod: string | null;
}

interface CheckConstraintRow {
  tableName: string;
  constraintName: string;
}

interface CountRow {
  count: number | string;
}

interface CurrentDatabaseRow {
  databaseName: string | null;
}

interface ColumnDefinition {
  table: string;
  legacy: string;
  final: string;
  columnType: string;
  nullable: 'YES' | 'NO';
  characterSet: string;
  collation: string;
}

interface FixedColumnDefinition {
  table: string;
  column: string;
  columnType: string;
  nullable: 'YES' | 'NO';
  characterSet: string;
  collation: string;
}

interface IndexDefinition {
  table: string;
  finalName: string;
  legacyNames: readonly string[];
  columns: readonly string[];
  unique: boolean;
}

interface PreservedIndexDefinition {
  table: string;
  allowedNames: readonly string[];
  columns: readonly string[];
  unique: boolean;
}

interface ForeignKeyDefinition {
  table: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  finalName: string;
  deleteRule: 'CASCADE' | 'RESTRICT';
}

interface GroupedIndex {
  tableName: string;
  indexName: string;
  unique: boolean;
  visible: boolean;
  plainAscendingBtree: boolean;
  columns: string[];
}

interface GroupedForeignKey {
  constraintSchema: string;
  tableSchema: string;
  tableName: string;
  constraintName: string;
  columns: string[];
  referencedTableSchema: string;
  referencedTableName: string;
  referencedColumns: string[];
  deleteRule: string;
  updateRule: string;
}

const RENAMED_COLUMNS = [
  {
    table: 'users',
    legacy: 'id',
    final: 'user_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'stores',
    legacy: 'id',
    final: 'store_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'stores',
    legacy: 'owner_id',
    final: 'user_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'products',
    legacy: 'id',
    final: 'product_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'products',
    legacy: 'seller_id',
    final: 'user_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'purchase_transactions',
    legacy: 'id',
    final: 'transaction_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'purchase_transactions',
    legacy: 'buyer_id',
    final: 'buyer_user_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'purchase_transactions',
    legacy: 'seller_id',
    final: 'seller_user_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'hono_sessions',
    legacy: 'id',
    final: 'session_id',
    columnType: 'char(64)',
    nullable: 'NO',
    characterSet: 'ascii',
    collation: 'ascii_bin',
  },
] as const satisfies readonly ColumnDefinition[];

const FIXED_ID_COLUMNS = [
  {
    table: 'products',
    column: 'store_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'purchase_transactions',
    column: 'product_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    table: 'hono_sessions',
    column: 'user_id',
    columnType: 'varchar(255)',
    nullable: 'YES',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
] as const satisfies readonly FixedColumnDefinition[];

const INDEXES = {
  storeUserUnique: {
    table: 'stores',
    finalName: 'stores_user_id_unique',
    legacyNames: ['owner_id', 'stores_owner_id_unique'],
    columns: ['user_id'],
    unique: true,
  },
  productUserCreatedAt: {
    table: 'products',
    finalName: 'products_user_id_created_at_index',
    legacyNames: ['products_seller_id_created_at_index'],
    columns: ['user_id', 'created_at'],
    unique: false,
  },
  transactionBuyerCreatedAt: {
    table: 'purchase_transactions',
    finalName: 'purchase_transactions_buyer_user_id_created_at_index',
    legacyNames: ['purchase_transactions_buyer_id_created_at_index'],
    columns: ['buyer_user_id', 'created_at'],
    unique: false,
  },
  transactionSellerCreatedAt: {
    table: 'purchase_transactions',
    finalName: 'purchase_transactions_seller_user_id_created_at_index',
    legacyNames: ['purchase_transactions_seller_id_created_at_index'],
    columns: ['seller_user_id', 'created_at'],
    unique: false,
  },
} as const satisfies Record<string, IndexDefinition>;

// These indexes do not change in 0001, but they are part of the 0000 schema
// contract. Keep the Laravel and Hono-generated names that can legitimately
// exist before this cutover instead of silently accepting an arbitrary index.
const PRESERVED_INDEXES = [
  {
    table: 'users',
    allowedNames: ['email', 'users_email_unique'],
    columns: ['email'],
    unique: true,
  },
  {
    table: 'users',
    allowedNames: ['users_role_index'],
    columns: ['role'],
    unique: false,
  },
  {
    table: 'stores',
    allowedNames: ['stores_sync_status_index'],
    columns: ['sync_status'],
    unique: false,
  },
  {
    table: 'products',
    allowedNames: ['products_category_index'],
    columns: ['category'],
    unique: false,
  },
  {
    table: 'products',
    allowedNames: ['products_created_at_index'],
    columns: ['created_at'],
    unique: false,
  },
  {
    table: 'products',
    allowedNames: ['products_store_id_created_at_index'],
    columns: ['store_id', 'created_at'],
    unique: false,
  },
  {
    table: 'purchase_transactions',
    allowedNames: ['purchase_transactions_request_id_unique'],
    columns: ['request_id'],
    unique: true,
  },
  {
    table: 'purchase_transactions',
    allowedNames: ['purchase_transactions_product_id_index'],
    columns: ['product_id'],
    unique: false,
  },
  {
    table: 'purchase_transactions',
    allowedNames: ['purchase_transactions_source_index'],
    columns: ['source'],
    unique: false,
  },
  {
    table: 'purchase_transactions',
    allowedNames: ['purchase_transactions_status_index'],
    columns: ['status'],
    unique: false,
  },
  {
    table: 'hono_sessions',
    allowedNames: ['hono_sessions_expiry'],
    columns: ['expires_at'],
    unique: false,
  },
  {
    table: 'hono_rate_limits',
    allowedNames: ['hono_rate_limits_expiry'],
    columns: ['expires_at'],
    unique: false,
  },
] as const satisfies readonly PreservedIndexDefinition[];

const FOREIGN_KEYS = {
  storeUser: {
    table: 'stores',
    column: 'user_id',
    referencedTable: 'users',
    referencedColumn: 'user_id',
    finalName: 'stores_user_id_foreign',
    deleteRule: 'RESTRICT',
  },
  productStore: {
    table: 'products',
    column: 'store_id',
    referencedTable: 'stores',
    referencedColumn: 'store_id',
    finalName: 'products_store_id_foreign',
    deleteRule: 'RESTRICT',
  },
  productUser: {
    table: 'products',
    column: 'user_id',
    referencedTable: 'users',
    referencedColumn: 'user_id',
    finalName: 'products_user_id_foreign',
    deleteRule: 'RESTRICT',
  },
  transactionProduct: {
    table: 'purchase_transactions',
    column: 'product_id',
    referencedTable: 'products',
    referencedColumn: 'product_id',
    finalName: 'purchase_transactions_product_id_foreign',
    deleteRule: 'RESTRICT',
  },
  transactionBuyer: {
    table: 'purchase_transactions',
    column: 'buyer_user_id',
    referencedTable: 'users',
    referencedColumn: 'user_id',
    finalName: 'purchase_transactions_buyer_user_id_foreign',
    deleteRule: 'RESTRICT',
  },
  transactionSeller: {
    table: 'purchase_transactions',
    column: 'seller_user_id',
    referencedTable: 'users',
    referencedColumn: 'user_id',
    finalName: 'purchase_transactions_seller_user_id_foreign',
    deleteRule: 'RESTRICT',
  },
  sessionUser: {
    table: 'hono_sessions',
    column: 'user_id',
    referencedTable: 'users',
    referencedColumn: 'user_id',
    finalName: 'hono_sessions_user_id_foreign',
    deleteRule: 'CASCADE',
  },
} as const satisfies Record<string, ForeignKeyDefinition>;

type IndexKey = keyof typeof INDEXES;
type ForeignKeyKey = keyof typeof FOREIGN_KEYS;

interface MigrationState {
  users: ColumnPhase;
  stores: ColumnPhase;
  products: ColumnPhase;
  transactions: ColumnPhase;
  sessions: ColumnPhase;
  storeUserUnique: ObjectPhase;
  productUserCreatedAt: ObjectPhase;
  transactionBuyerCreatedAt: ObjectPhase;
  transactionSellerCreatedAt: ObjectPhase;
  storeUser: ObjectPhase;
  productStore: ObjectPhase;
  productUser: ObjectPhase;
  transactionProduct: ObjectPhase;
  transactionBuyer: ObjectPhase;
  transactionSeller: ObjectPhase;
  sessionUser: ObjectPhase;
}

interface InspectedObject<T> {
  phase: ObjectPhase;
  object?: T;
}

interface EntityIdInspection {
  databaseName: string;
  stage: number;
  state: MigrationState;
  indexes: Record<IndexKey, InspectedObject<GroupedIndex>>;
  foreignKeys: Record<ForeignKeyKey, InspectedObject<GroupedForeignKey>>;
}

export class EntityIdMigrationError extends Error {
  readonly code = 'MINETENANT_ENTITY_ID_MIGRATION_UNSAFE';

  constructor(message: string) {
    super(message);
    this.name = 'EntityIdMigrationError';
  }
}

function unsafe(message: string): never {
  throw new EntityIdMigrationError(message);
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``;
}

function sameColumns(first: readonly string[], second: readonly string[]) {
  return (
    first.length === second.length &&
    first.every((column, index) => column === second[index])
  );
}

function groupIndexes(rows: readonly IndexRow[]): GroupedIndex[] {
  const grouped = new Map<string, GroupedIndex>();
  for (const row of rows) {
    const key = `${row.tableName}\0${row.indexName}`;
    const index = grouped.get(key) ?? {
      tableName: row.tableName,
      indexName: row.indexName,
      unique: Number(row.nonUnique) === 0,
      visible: row.isVisible === 'YES',
      plainAscendingBtree:
        row.expression === null &&
        row.subPart === null &&
        row.collation === 'A' &&
        row.indexType === 'BTREE',
      columns: [],
    };
    index.plainAscendingBtree &&=
      row.expression === null &&
      row.subPart === null &&
      row.collation === 'A' &&
      row.indexType === 'BTREE';
    index.columns[row.sequence - 1] =
      row.columnName ?? `#functional-expression-${row.sequence}`;
    grouped.set(key, index);
  }
  return [...grouped.values()];
}

function groupForeignKeys(rows: readonly ForeignKeyRow[]): GroupedForeignKey[] {
  const grouped = new Map<string, GroupedForeignKey>();
  for (const row of rows) {
    const key = `${row.constraintSchema}\0${row.tableName}\0${row.constraintName}`;
    const foreignKey = grouped.get(key) ?? {
      constraintSchema: row.constraintSchema,
      tableSchema: row.tableSchema,
      tableName: row.tableName,
      constraintName: row.constraintName,
      columns: [],
      referencedTableSchema: row.referencedTableSchema,
      referencedTableName: row.referencedTableName,
      referencedColumns: [],
      deleteRule: row.deleteRule,
      updateRule: row.updateRule,
    };
    foreignKey.columns[row.sequence - 1] = row.columnName;
    foreignKey.referencedColumns[row.sequence - 1] = row.referencedColumnName;
    grouped.set(key, foreignKey);
  }
  return [...grouped.values()];
}

function columnKey(table: string, column: string): string {
  return `${table}.${column}`;
}

function currentColumn(
  table: string,
  finalColumn: string,
  phases: ReadonlyMap<string, ColumnPhase>,
): string {
  const definition = RENAMED_COLUMNS.find(
    (candidate) => candidate.table === table && candidate.final === finalColumn,
  );
  if (!definition) return finalColumn;
  return phases.get(columnKey(table, finalColumn)) === 'legacy'
    ? definition.legacy
    : definition.final;
}

function assertColumnDefinition(
  row: ColumnRow,
  expected:
    | Pick<
        ColumnDefinition,
        'columnType' | 'nullable' | 'characterSet' | 'collation'
      >
    | Pick<
        FixedColumnDefinition,
        'columnType' | 'nullable' | 'characterSet' | 'collation'
      >,
): void {
  if (
    row.columnType.toLowerCase() !== expected.columnType ||
    row.isNullable !== expected.nullable ||
    row.characterSetName?.toLowerCase() !== expected.characterSet ||
    row.collationName?.toLowerCase() !== expected.collation
  ) {
    unsafe(`Unexpected definition for ${row.tableName}.${row.columnName}.`);
  }
}

function inspectColumns(rows: readonly ColumnRow[]) {
  const byName = new Map(
    rows.map((row) => [columnKey(row.tableName, row.columnName), row]),
  );
  const phases = new Map<string, ColumnPhase>();

  for (const definition of RENAMED_COLUMNS) {
    const legacy = byName.get(columnKey(definition.table, definition.legacy));
    const final = byName.get(columnKey(definition.table, definition.final));
    if (legacy && final) {
      unsafe(
        `Both legacy and final columns exist for ${definition.table}.${definition.final}.`,
      );
    }
    const present = legacy ?? final;
    if (!present) {
      unsafe(
        `Neither legacy nor final column exists for ${definition.table}.${definition.final}.`,
      );
    }
    assertColumnDefinition(present, definition);
    phases.set(
      columnKey(definition.table, definition.final),
      legacy ? 'legacy' : 'final',
    );
  }

  for (const definition of FIXED_ID_COLUMNS) {
    const row = byName.get(columnKey(definition.table, definition.column));
    if (!row)
      unsafe(
        `Required column is missing: ${definition.table}.${definition.column}.`,
      );
    assertColumnDefinition(row, definition);
  }

  for (const [table, requiredColumns] of Object.entries(
    ENTITY_ID_SCHEMA_REQUIREMENTS.tables,
  )) {
    for (const finalColumn of requiredColumns) {
      const renamed = RENAMED_COLUMNS.find(
        (candidate) =>
          candidate.table === table && candidate.final === finalColumn,
      );
      const required = renamed
        ? currentColumn(table, finalColumn, phases)
        : finalColumn;
      if (!byName.has(columnKey(table, required))) {
        unsafe(`Required column is missing: ${table}.${required}.`);
      }
    }
  }

  const group = (table: string): ColumnPhase => {
    const present = RENAMED_COLUMNS.filter(
      (definition) => definition.table === table,
    ).map((definition) => phases.get(columnKey(table, definition.final))!);
    if (present.some((phase) => phase !== present[0])) {
      unsafe(`Columns in ${table} are not in a known atomic migration state.`);
    }
    return present[0]!;
  };

  return {
    phases,
    groups: {
      users: group('users'),
      stores: group('stores'),
      products: group('products'),
      transactions: group('purchase_transactions'),
      sessions: group('hono_sessions'),
    },
  };
}

function inspectIndex(
  allIndexes: readonly GroupedIndex[],
  definition: IndexDefinition,
  phases: ReadonlyMap<string, ColumnPhase>,
): InspectedObject<GroupedIndex> {
  const currentColumns = definition.columns.map((column) =>
    currentColumn(definition.table, column, phases),
  );
  const finalByName = allIndexes.find(
    (index) =>
      index.tableName === definition.table &&
      index.indexName === definition.finalName,
  );
  if (
    finalByName &&
    (finalByName.unique !== definition.unique ||
      !finalByName.visible ||
      !finalByName.plainAscendingBtree ||
      !sameColumns(finalByName.columns, currentColumns))
  ) {
    unsafe(`Index name collision: ${definition.finalName}.`);
  }
  for (const legacyName of definition.legacyNames) {
    const legacyByName = allIndexes.find(
      (index) =>
        index.tableName === definition.table && index.indexName === legacyName,
    );
    if (
      legacyByName &&
      (legacyByName.unique !== definition.unique ||
        !legacyByName.visible ||
        !legacyByName.plainAscendingBtree ||
        !sameColumns(legacyByName.columns, currentColumns))
    ) {
      unsafe(
        `Unexpected legacy index definition: ${definition.table}.${legacyName}.`,
      );
    }
  }
  const semantic = allIndexes.filter(
    (index) =>
      index.tableName === definition.table &&
      index.unique === definition.unique &&
      index.visible &&
      index.plainAscendingBtree &&
      sameColumns(index.columns, currentColumns),
  );
  if (semantic.length > 1) {
    unsafe(
      `Duplicate indexes exist for ${definition.table}.${currentColumns.join(',')}.`,
    );
  }
  const [index] = semantic;
  if (!index) return { phase: 'missing' };
  if (index.indexName === definition.finalName) {
    return {
      phase: sameColumns(currentColumns, definition.columns)
        ? 'final'
        : 'legacy',
      object: index,
    };
  }
  return { phase: 'legacy', object: index };
}

function assertPreservedIndexes(indexes: readonly GroupedIndex[]): void {
  for (const definition of PRESERVED_INDEXES) {
    const named = indexes.filter(
      (index) =>
        index.tableName === definition.table &&
        definition.allowedNames.some((name) => name === index.indexName),
    );
    if (
      named.some(
        (index) =>
          index.unique !== definition.unique ||
          !index.visible ||
          !index.plainAscendingBtree ||
          !sameColumns(index.columns, definition.columns),
      )
    ) {
      unsafe(
        `Unexpected preserved index definition: ${definition.table}.${definition.allowedNames.join('|')}.`,
      );
    }

    const semantic = indexes.filter(
      (index) =>
        index.tableName === definition.table &&
        index.unique === definition.unique &&
        index.visible &&
        index.plainAscendingBtree &&
        sameColumns(index.columns, definition.columns),
    );
    if (
      semantic.length !== 1 ||
      named.length !== 1 ||
      semantic[0] !== named[0]
    ) {
      unsafe(
        `Required preserved index is missing or ambiguous: ${definition.table}.${definition.allowedNames.join('|')}.`,
      );
    }
  }
}

function inspectForeignKey(
  allForeignKeys: readonly GroupedForeignKey[],
  definition: ForeignKeyDefinition,
  phases: ReadonlyMap<string, ColumnPhase>,
  databaseName: string,
): InspectedObject<GroupedForeignKey> {
  const column = currentColumn(definition.table, definition.column, phases);
  const referencedColumn = currentColumn(
    definition.referencedTable,
    definition.referencedColumn,
    phases,
  );
  const finalByName = allForeignKeys.find(
    (foreignKey) =>
      foreignKey.constraintSchema === databaseName &&
      foreignKey.constraintName === definition.finalName,
  );
  const matches = allForeignKeys.filter(
    (foreignKey) =>
      foreignKey.tableSchema === databaseName &&
      foreignKey.referencedTableSchema === databaseName &&
      foreignKey.tableName === definition.table &&
      sameColumns(foreignKey.columns, [column]) &&
      foreignKey.referencedTableName === definition.referencedTable &&
      sameColumns(foreignKey.referencedColumns, [referencedColumn]) &&
      foreignKey.deleteRule === definition.deleteRule &&
      ['NO ACTION', 'RESTRICT'].includes(foreignKey.updateRule),
  );
  if (matches.length > 1) {
    unsafe(`Duplicate foreign keys exist for ${definition.table}.${column}.`);
  }
  const [foreignKey] = matches;
  if (finalByName && finalByName !== foreignKey) {
    unsafe(`Foreign key name collision: ${definition.finalName}.`);
  }
  if (!foreignKey) return { phase: 'missing' };
  if (foreignKey.constraintName === definition.finalName) {
    return {
      phase:
        column === definition.column &&
        referencedColumn === definition.referencedColumn
          ? 'final'
          : 'legacy',
      object: foreignKey,
    };
  }
  return { phase: 'legacy', object: foreignKey };
}

function expectedState(stage: number): MigrationState {
  return {
    users: stage >= 5 ? 'final' : 'legacy',
    stores: stage >= 6 ? 'final' : 'legacy',
    products: stage >= 7 ? 'final' : 'legacy',
    transactions: stage >= 8 ? 'final' : 'legacy',
    sessions: stage >= 9 ? 'final' : 'legacy',
    storeUserUnique: stage === 0 ? 'legacy' : stage >= 6 ? 'final' : 'missing',
    productUserCreatedAt:
      stage <= 1 ? 'legacy' : stage >= 7 ? 'final' : 'missing',
    transactionBuyerCreatedAt:
      stage <= 2 ? 'legacy' : stage >= 8 ? 'final' : 'missing',
    transactionSellerCreatedAt:
      stage <= 2 ? 'legacy' : stage >= 8 ? 'final' : 'missing',
    storeUser: stage === 0 ? 'legacy' : stage >= 10 ? 'final' : 'missing',
    productStore: stage <= 1 ? 'legacy' : stage >= 11 ? 'final' : 'missing',
    productUser: stage <= 1 ? 'legacy' : stage >= 11 ? 'final' : 'missing',
    transactionProduct:
      stage <= 2 ? 'legacy' : stage >= 12 ? 'final' : 'missing',
    transactionBuyer: stage <= 2 ? 'legacy' : stage >= 12 ? 'final' : 'missing',
    transactionSeller:
      stage <= 2 ? 'legacy' : stage >= 12 ? 'final' : 'missing',
    sessionUser: stage <= 3 ? 'legacy' : stage >= 13 ? 'final' : 'missing',
  };
}

function sameState(first: MigrationState, second: MigrationState): boolean {
  return (Object.keys(first) as (keyof MigrationState)[]).every(
    (key) => first[key] === second[key],
  );
}

function assertPrimaryKeys(
  indexes: readonly GroupedIndex[],
  phases: ReadonlyMap<string, ColumnPhase>,
): void {
  const definitions = [
    ['users', 'user_id'],
    ['stores', 'store_id'],
    ['products', 'product_id'],
    ['purchase_transactions', 'transaction_id'],
    ['hono_sessions', 'session_id'],
    ['hono_rate_limits', 'key_hash'],
  ] as const;
  for (const [table, finalColumn] of definitions) {
    const column = currentColumn(table, finalColumn, phases);
    const primary = indexes.find(
      (index) => index.tableName === table && index.indexName === 'PRIMARY',
    );
    if (
      !primary ||
      !primary.unique ||
      !primary.visible ||
      !primary.plainAscendingBtree ||
      !sameColumns(primary.columns, [column])
    ) {
      unsafe(`Unexpected primary key for ${table}.`);
    }
  }
}

function isRelevantIndex(index: GroupedIndex): boolean {
  return RENAMED_COLUMNS.some(
    (definition) =>
      definition.table === index.tableName &&
      index.columns.some(
        (column) => column === definition.legacy || column === definition.final,
      ),
  );
}

function isRelevantForeignKey(
  foreignKey: GroupedForeignKey,
  databaseName: string,
): boolean {
  const touchesRenamedColumn = (
    schema: string,
    table: string,
    columns: readonly string[],
  ) =>
    schema === databaseName &&
    RENAMED_COLUMNS.some(
      (definition) =>
        definition.table === table &&
        columns.some(
          (column) =>
            column === definition.legacy || column === definition.final,
        ),
    );

  return (
    touchesRenamedColumn(
      foreignKey.tableSchema,
      foreignKey.tableName,
      foreignKey.columns,
    ) ||
    touchesRenamedColumn(
      foreignKey.referencedTableSchema,
      foreignKey.referencedTableName,
      foreignKey.referencedColumns,
    )
  );
}

function isRenamedTable(tableName: string): boolean {
  return RENAMED_COLUMNS.some((definition) => definition.table === tableName);
}

function assertNoStoredSchemaObjects(
  objects: Readonly<{
    views: readonly SchemaObjectRow[];
    triggers: readonly SchemaObjectRow[];
    routines: readonly SchemaObjectRow[];
    events: readonly SchemaObjectRow[];
  }>,
): void {
  // MySQL has no complete column-level dependency graph for stored objects, and
  // routine/event bodies may use dynamic SQL. RENAME COLUMN does not rewrite
  // views or stored programs. Reject every stored object in the selected
  // application schema, plus visible cross-schema views that use a renamed
  // table, rather than trying to parse SQL text.
  for (const [kind, rows] of Object.entries(objects)) {
    const [row] = rows;
    if (row) {
      unsafe(
        `A ${kind.slice(0, -1)} must be reviewed before renaming entity IDs: ${row.objectName}.`,
      );
    }
  }
}

function assertNoTableExpressionDependencies(
  columns: readonly ColumnRow[],
  indexes: readonly IndexRow[],
  partitions: readonly PartitionRow[],
  checks: readonly CheckConstraintRow[],
): void {
  // Generated/default expressions, functional indexes, partitions and CHECK
  // clauses are stored as SQL text. Identifier-aware parsing must account for
  // quoting, case and SQL modes, so reject any of them on a renamed table. The
  // 0000 and Laravel schemas do not contain these objects.
  const generated = columns.find(
    (column) =>
      isRenamedTable(column.tableName) &&
      ((column.generationExpression?.trim().length ?? 0) > 0 ||
        /\b(?:VIRTUAL|STORED) GENERATED\b/i.test(column.extra)),
  );
  if (generated) {
    unsafe(
      `Generated column must be reviewed before renaming entity IDs: ${generated.tableName}.${generated.columnName}.`,
    );
  }

  const expressionDefault = columns.find(
    (column) =>
      isRenamedTable(column.tableName) &&
      column.extra.toUpperCase().split(/\s+/).includes('DEFAULT_GENERATED'),
  );
  if (expressionDefault) {
    unsafe(
      `Expression default must be reviewed before renaming entity IDs: ${expressionDefault.tableName}.${expressionDefault.columnName} (${expressionDefault.columnDefault ?? 'expression'}).`,
    );
  }

  const functional = indexes.find(
    (index) => isRenamedTable(index.tableName) && index.expression !== null,
  );
  if (functional) {
    unsafe(
      `Functional index must be reviewed before renaming entity IDs: ${functional.tableName}.${functional.indexName}.`,
    );
  }

  const [partition] = partitions;
  if (partition) {
    unsafe(
      `Partitioned table must be reviewed before renaming entity IDs: ${partition.tableName} (${partition.partitionMethod ?? partition.subpartitionMethod ?? 'unknown'}).`,
    );
  }

  const [check] = checks;
  if (check) {
    unsafe(
      `CHECK constraint must be reviewed before renaming entity IDs: ${check.tableName}.${check.constraintName}.`,
    );
  }
}

async function assertNoOrphans(
  db: MigrationExecutor,
  phases: ReadonlyMap<string, ColumnPhase>,
): Promise<void> {
  for (const definition of Object.values(FOREIGN_KEYS)) {
    const column = currentColumn(definition.table, definition.column, phases);
    const referencedColumn = currentColumn(
      definition.referencedTable,
      definition.referencedColumn,
      phases,
    );
    const [row] = await db.query<CountRow>(
      `SELECT COUNT(*) AS count
         FROM ${quoteIdentifier(definition.table)} AS child
         LEFT JOIN ${quoteIdentifier(definition.referencedTable)} AS parent
           ON parent.${quoteIdentifier(referencedColumn)} = child.${quoteIdentifier(column)}
        WHERE child.${quoteIdentifier(column)} IS NOT NULL
          AND parent.${quoteIdentifier(referencedColumn)} IS NULL`,
    );
    if (Number(row?.count) !== 0) {
      unsafe(`Orphan rows exist for ${definition.table}.${column}.`);
    }
  }
  const storeUserColumn = currentColumn('stores', 'user_id', phases);
  const [duplicate] = await db.query<CountRow>(
    `SELECT COUNT(*) AS count
       FROM (
         SELECT ${quoteIdentifier(storeUserColumn)}
           FROM stores
          GROUP BY ${quoteIdentifier(storeUserColumn)}
         HAVING COUNT(*) > 1
       ) AS duplicate_store_users`,
  );
  if (Number(duplicate?.count) !== 0) {
    unsafe(`Duplicate values exist for stores.${storeUserColumn}.`);
  }
}

async function inspectEntityIdState(
  db: MigrationExecutor,
): Promise<EntityIdInspection> {
  const [current] = await db.query<CurrentDatabaseRow>(
    'SELECT DATABASE() AS databaseName',
  );
  if (!current?.databaseName) {
    unsafe('A database must be selected before running migrations.');
  }
  const databaseName = current.databaseName;
  const [
    tableRows,
    columnRows,
    indexRows,
    foreignKeyRows,
    views,
    triggers,
    routines,
    events,
    partitions,
    checks,
  ] = await Promise.all([
    db.query<TableRow>(
      `SELECT TABLE_NAME AS tableName, ENGINE AS engine
         FROM information_schema.tables
        WHERE table_schema = ?`,
      [databaseName],
    ),
    db.query<ColumnRow>(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
              COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
              CHARACTER_SET_NAME AS characterSetName,
              COLLATION_NAME AS collationName,
              COLUMN_DEFAULT AS columnDefault, EXTRA AS extra,
              GENERATION_EXPRESSION AS generationExpression
         FROM information_schema.columns
        WHERE table_schema = ?`,
      [databaseName],
    ),
    db.query<IndexRow>(
      `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
              NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
              COLUMN_NAME AS columnName, IS_VISIBLE AS isVisible,
              EXPRESSION AS expression, SUB_PART AS subPart,
              COLLATION AS collation, INDEX_TYPE AS indexType
         FROM information_schema.statistics
        WHERE table_schema = ?
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [databaseName],
    ),
    db.query<ForeignKeyRow>(
      `SELECT k.CONSTRAINT_SCHEMA AS constraintSchema,
              k.TABLE_SCHEMA AS tableSchema, k.TABLE_NAME AS tableName,
              k.CONSTRAINT_NAME AS constraintName,
              k.COLUMN_NAME AS columnName,
              k.REFERENCED_TABLE_SCHEMA AS referencedTableSchema,
              k.REFERENCED_TABLE_NAME AS referencedTableName,
              k.REFERENCED_COLUMN_NAME AS referencedColumnName,
              k.ORDINAL_POSITION AS sequence, r.DELETE_RULE AS deleteRule,
              r.UPDATE_RULE AS updateRule
         FROM information_schema.key_column_usage AS k
         JOIN information_schema.referential_constraints AS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.TABLE_NAME = k.TABLE_NAME
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.REFERENCED_TABLE_NAME IS NOT NULL
          AND (k.TABLE_SCHEMA = ? OR k.REFERENCED_TABLE_SCHEMA = ?)
        ORDER BY k.CONSTRAINT_SCHEMA, k.TABLE_NAME,
                 k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [databaseName, databaseName],
    ),
    db.query<SchemaObjectRow>(
      `SELECT objectName
         FROM (
           SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS objectName
             FROM information_schema.views
            WHERE TABLE_SCHEMA = ?
           UNION DISTINCT
           SELECT CONCAT(VIEW_SCHEMA, '.', VIEW_NAME) AS objectName
             FROM information_schema.view_table_usage
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME IN ('users', 'stores', 'products',
                                 'purchase_transactions', 'hono_sessions')
         ) AS unsafe_views
        LIMIT 1`,
      [databaseName, databaseName],
    ),
    db.query<SchemaObjectRow>(
      `SELECT TRIGGER_NAME AS objectName
         FROM information_schema.triggers
        WHERE trigger_schema = ? LIMIT 1`,
      [databaseName],
    ),
    db.query<SchemaObjectRow>(
      `SELECT ROUTINE_NAME AS objectName
         FROM information_schema.routines
        WHERE routine_schema = ? LIMIT 1`,
      [databaseName],
    ),
    db.query<SchemaObjectRow>(
      `SELECT EVENT_NAME AS objectName
         FROM information_schema.events
        WHERE event_schema = ? LIMIT 1`,
      [databaseName],
    ),
    db.query<PartitionRow>(
      `SELECT TABLE_NAME AS tableName, PARTITION_METHOD AS partitionMethod,
              SUBPARTITION_METHOD AS subpartitionMethod
         FROM information_schema.partitions
        WHERE table_schema = ?
          AND table_name IN ('users', 'stores', 'products',
                             'purchase_transactions', 'hono_sessions')
          AND (PARTITION_METHOD IS NOT NULL OR SUBPARTITION_METHOD IS NOT NULL)
        LIMIT 1`,
      [databaseName],
    ),
    db.query<CheckConstraintRow>(
      `SELECT tc.TABLE_NAME AS tableName,
              tc.CONSTRAINT_NAME AS constraintName
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.check_constraints AS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.TABLE_SCHEMA = ?
          AND tc.CONSTRAINT_TYPE = 'CHECK'
          AND tc.TABLE_NAME IN ('users', 'stores', 'products',
                                'purchase_transactions', 'hono_sessions')
        LIMIT 1`,
      [databaseName],
    ),
  ]);

  assertNoStoredSchemaObjects({ views, triggers, routines, events });
  assertNoTableExpressionDependencies(
    columnRows,
    indexRows,
    partitions,
    checks,
  );

  for (const table of Object.keys(ENTITY_ID_SCHEMA_REQUIREMENTS.tables)) {
    const metadata = tableRows.find((row) => row.tableName === table);
    if (!metadata || metadata.engine?.toUpperCase() !== 'INNODB') {
      unsafe(`Required table is not InnoDB: ${table}.`);
    }
  }

  const columns = inspectColumns(columnRows);
  const groupedIndexes = groupIndexes(indexRows);
  const groupedForeignKeys = groupForeignKeys(foreignKeyRows);
  assertPrimaryKeys(groupedIndexes, columns.phases);
  assertPreservedIndexes(groupedIndexes);

  const indexes = Object.fromEntries(
    Object.entries(INDEXES).map(([key, definition]) => [
      key,
      inspectIndex(groupedIndexes, definition, columns.phases),
    ]),
  ) as Record<IndexKey, InspectedObject<GroupedIndex>>;
  const expectedIndexKeys = new Set(
    Object.values(indexes)
      .map(({ object }) =>
        object ? `${object.tableName}\0${object.indexName}` : undefined,
      )
      .filter((key): key is string => key !== undefined),
  );
  const unexpectedIndex = groupedIndexes.find(
    (index) =>
      index.indexName !== 'PRIMARY' &&
      isRelevantIndex(index) &&
      !expectedIndexKeys.has(`${index.tableName}\0${index.indexName}`),
  );
  if (unexpectedIndex) {
    unsafe(
      `Unexpected index touches an entity ID: ${unexpectedIndex.tableName}.${unexpectedIndex.indexName}.`,
    );
  }
  const foreignKeys = Object.fromEntries(
    Object.entries(FOREIGN_KEYS).map(([key, definition]) => [
      key,
      inspectForeignKey(
        groupedForeignKeys,
        definition,
        columns.phases,
        databaseName,
      ),
    ]),
  ) as Record<ForeignKeyKey, InspectedObject<GroupedForeignKey>>;

  const expectedConstraintKeys = new Set(
    Object.values(foreignKeys)
      .map(({ object }) =>
        object
          ? `${object.constraintSchema}\0${object.tableName}\0${object.constraintName}`
          : undefined,
      )
      .filter((key): key is string => key !== undefined),
  );
  const unexpected = groupedForeignKeys.find(
    (foreignKey) =>
      isRelevantForeignKey(foreignKey, databaseName) &&
      !expectedConstraintKeys.has(
        `${foreignKey.constraintSchema}\0${foreignKey.tableName}\0${foreignKey.constraintName}`,
      ),
  );
  if (unexpected) {
    unsafe(
      `Unexpected foreign key touches an entity ID: ${unexpected.constraintSchema}.${unexpected.tableName}.${unexpected.constraintName}.`,
    );
  }

  const state: MigrationState = {
    ...columns.groups,
    ...Object.fromEntries(
      Object.entries(indexes).map(([key, value]) => [key, value.phase]),
    ),
    ...Object.fromEntries(
      Object.entries(foreignKeys).map(([key, value]) => [key, value.phase]),
    ),
  } as MigrationState;
  let stage = -1;
  for (let candidate = 0; candidate <= FINAL_STAGE; candidate += 1) {
    if (sameState(state, expectedState(candidate))) {
      stage = candidate;
      break;
    }
  }
  if (stage < 0) {
    unsafe('The entity ID schema is not a known resumable migration state.');
  }
  await assertNoOrphans(db, columns.phases);
  return { databaseName, stage, state, indexes, foreignKeys };
}

function requireObject<T>(inspected: InspectedObject<T>, label: string): T {
  if (!inspected.object)
    unsafe(`${label} is missing from the expected migration stage.`);
  return inspected.object;
}

async function applyNextStage(
  db: MigrationExecutor,
  inspection: EntityIdInspection,
): Promise<void> {
  const foreignKeyName = (key: ForeignKeyKey) =>
    quoteIdentifier(
      requireObject(inspection.foreignKeys[key], String(key)).constraintName,
    );
  const indexName = (key: IndexKey) =>
    quoteIdentifier(
      requireObject(inspection.indexes[key], String(key)).indexName,
    );

  switch (inspection.stage) {
    case 0:
      await db.execute(`ALTER TABLE stores
        DROP FOREIGN KEY ${foreignKeyName('storeUser')},
        DROP INDEX ${indexName('storeUserUnique')}`);
      return;
    case 1:
      await db.execute(`ALTER TABLE products
        DROP FOREIGN KEY ${foreignKeyName('productStore')},
        DROP FOREIGN KEY ${foreignKeyName('productUser')},
        DROP INDEX ${indexName('productUserCreatedAt')}`);
      return;
    case 2:
      await db.execute(`ALTER TABLE purchase_transactions
        DROP FOREIGN KEY ${foreignKeyName('transactionProduct')},
        DROP FOREIGN KEY ${foreignKeyName('transactionBuyer')},
        DROP FOREIGN KEY ${foreignKeyName('transactionSeller')},
        DROP INDEX ${indexName('transactionBuyerCreatedAt')},
        DROP INDEX ${indexName('transactionSellerCreatedAt')}`);
      return;
    case 3:
      await db.execute(`ALTER TABLE hono_sessions
        DROP FOREIGN KEY ${foreignKeyName('sessionUser')}`);
      return;
    case 4:
      await db.execute('ALTER TABLE users RENAME COLUMN id TO user_id');
      return;
    case 5:
      await db.execute(`ALTER TABLE stores
        RENAME COLUMN id TO store_id,
        RENAME COLUMN owner_id TO user_id,
        ADD UNIQUE INDEX stores_user_id_unique (user_id)`);
      return;
    case 6:
      await db.execute(`ALTER TABLE products
        RENAME COLUMN id TO product_id,
        RENAME COLUMN seller_id TO user_id,
        ADD INDEX products_user_id_created_at_index (user_id, created_at)`);
      return;
    case 7:
      await db.execute(`ALTER TABLE purchase_transactions
        RENAME COLUMN id TO transaction_id,
        RENAME COLUMN buyer_id TO buyer_user_id,
        RENAME COLUMN seller_id TO seller_user_id,
        ADD INDEX purchase_transactions_buyer_user_id_created_at_index (buyer_user_id, created_at),
        ADD INDEX purchase_transactions_seller_user_id_created_at_index (seller_user_id, created_at)`);
      return;
    case 8:
      await db.execute(
        'ALTER TABLE hono_sessions RENAME COLUMN id TO session_id',
      );
      return;
    case 9:
      await db.execute(`ALTER TABLE stores
        ADD CONSTRAINT stores_user_id_foreign
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT`);
      return;
    case 10:
      await db.execute(`ALTER TABLE products
        ADD CONSTRAINT products_store_id_foreign
          FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE RESTRICT,
        ADD CONSTRAINT products_user_id_foreign
          FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT`);
      return;
    case 11:
      await db.execute(`ALTER TABLE purchase_transactions
        ADD CONSTRAINT purchase_transactions_product_id_foreign
          FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT,
        ADD CONSTRAINT purchase_transactions_buyer_user_id_foreign
          FOREIGN KEY (buyer_user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
        ADD CONSTRAINT purchase_transactions_seller_user_id_foreign
          FOREIGN KEY (seller_user_id) REFERENCES users(user_id) ON DELETE RESTRICT`);
      return;
    case 12:
      await db.execute(`ALTER TABLE hono_sessions
        ADD CONSTRAINT hono_sessions_user_id_foreign
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE`);
      return;
    default:
      return;
  }
}

export const entityIdColumnsMigration: Migration = {
  version: '0001_entity_id_columns',
  async preflight(db: MigrationExecutor): Promise<void> {
    await inspectEntityIdState(db);
  },
  async up(db: MigrationExecutor): Promise<void> {
    for (;;) {
      const inspection = await inspectEntityIdState(db);
      if (inspection.stage === FINAL_STAGE) return;
      await applyNextStage(db, inspection);
    }
  },
  async verify(db: MigrationExecutor): Promise<void> {
    const inspection = await inspectEntityIdState(db);
    if (inspection.stage !== FINAL_STAGE) {
      unsafe(`Entity ID migration stopped at stage ${inspection.stage}.`);
    }
    const readiness = await inspectDatabaseReadiness(
      db,
      inspection.databaseName,
      ENTITY_ID_SCHEMA_REQUIREMENTS,
    );
    if (readinessProblems(readiness).length > 0) {
      throw new DatabaseReadinessError(readiness);
    }
  },
};
