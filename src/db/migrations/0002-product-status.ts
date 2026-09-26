import type { MigrationExecutor, SqlExecutor } from '../../db.js';
import {
  inspectDatabaseReadiness,
  readinessProblems,
  type SchemaRequirements,
} from '../../readiness.js';
import {
  PRODUCT_STATUS_AUDIT_REQUIRED_COLUMNS,
  PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS,
  PRODUCT_STATUS_PRODUCT_AUDIT_TABLE,
  PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
} from '../product-status-audit-contract.js';
import {
  normalizeTriggerStatement,
  PRODUCT_STATUS_TRIGGER_CONTRACTS,
} from '../product-status-trigger-contract.js';
import { ENTITY_ID_SCHEMA_REQUIREMENTS } from './0001-entity-id-columns.js';
import type { Migration } from './types.js';

const PRODUCT_STATUS_ERROR_CODE = 'MINETENANT_PRODUCT_STATUS_MIGRATION_UNSAFE';

export const PRODUCT_STATUS_SCHEMA_REQUIREMENTS = {
  tables: {
    ...ENTITY_ID_SCHEMA_REQUIREMENTS.tables,
    products: [
      ...ENTITY_ID_SCHEMA_REQUIREMENTS.tables.products,
      'status',
      'listing_request_id',
      'listing_request_fingerprint',
      'deleted_at',
    ],
    ...PRODUCT_STATUS_AUDIT_REQUIRED_COLUMNS,
  },
  uniqueKeys: [
    ...ENTITY_ID_SCHEMA_REQUIREMENTS.uniqueKeys,
    {
      table: 'products',
      columns: ['user_id', 'listing_request_id'],
    },
    { table: 'products', columns: ['product_id', 'user_id'] },
    { table: 'purchase_transactions', column: 'product_id' },
    ...PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS.map(({ name, primaryKey }) => ({
      table: name,
      columns: primaryKey,
    })),
  ],
  triggers: PRODUCT_STATUS_TRIGGER_CONTRACTS,
  exactTables: PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS,
} as const satisfies SchemaRequirements;

interface CurrentDatabaseRow {
  databaseName: string | null;
}

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

interface CheckRow {
  tableName: string;
  constraintName: string;
  checkClause: string;
  enforced: string;
}

interface TriggerRow {
  triggerName: string;
  eventObjectTable: string;
  eventManipulation: string;
  actionTiming: string;
  actionOrientation: string;
  actionStatement: string;
}

interface StatusPopulationRow {
  total: number | string;
  nullCount: number | string;
}

type ProductStatusPopulationState = 'empty' | 'unpopulated' | 'populated';

interface IdRow {
  id: string;
}

interface ProductAuditRow {
  productCount: number | string;
  totalPrice: number | string | null;
  zeroStockCount: number | string;
  oneStockCount: number | string;
  multipleStockCount: number | string;
}

interface TransactionAuditRow {
  transactionCount: number | string;
  totalAmount: number | string | null;
}

interface TableRow {
  tableName: string;
  engine: string | null;
  tableCollation: string | null;
}

interface TableConstraintRow {
  tableName: string;
  constraintName: string;
  constraintType: string;
}

interface AuditTriggerRow {
  triggerName: string;
  eventObjectTable: string;
}

interface MigrationSnapshot {
  productCount: string;
  totalPrice: string;
  transactionCount: string;
  totalAmount: string;
}

interface ColumnDefinition {
  table: string;
  column: string;
  columnType: string;
  nullable: 'YES' | 'NO';
  characterSet: string | null;
  collation: string | null;
  defaultValue: string | null;
}

interface IndexDefinition {
  table: string;
  name: string;
  columns: readonly string[];
  unique: boolean;
}

interface ForeignKeyDefinition {
  table: string;
  name: string;
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
  deleteRule: 'RESTRICT';
  updateRule: 'RESTRICT';
}

interface CheckDefinition {
  table: string;
  name: string;
  clause: string;
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

interface ProductStatusSchema {
  databaseName: string;
  columns: Map<string, ColumnRow>;
  indexes: GroupedIndex[];
  foreignKeys: GroupedForeignKey[];
  checks: CheckRow[];
  triggers: TriggerRow[];
  productColumnsPresent: boolean;
  requestIdFinal: boolean;
}

export class ProductStatusMigrationError extends Error {
  readonly code = PRODUCT_STATUS_ERROR_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProductStatusMigrationError';
  }
}

function unsafe(message: string, cause?: unknown): never {
  throw new ProductStatusMigrationError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isMysqlError(error: unknown, code: string, errno: number): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === code || Number(candidate.errno) === errno;
}

function columnKey(table: string, column: string): string {
  return `${table}.${column}`;
}

function sameColumns(first: readonly string[], second: readonly string[]) {
  return (
    first.length === second.length &&
    first.every((column, index) => column === second[index])
  );
}

function sameUpdateRule(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  return (
    (actual === 'NO ACTION' || actual === 'RESTRICT') &&
    (expected === 'NO ACTION' || expected === 'RESTRICT')
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
      plainAscendingBtree: true,
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

const PRODUCT_COLUMNS = [
  {
    table: 'products',
    column: 'status',
    columnType: 'varchar(16)',
    nullable: 'YES',
    characterSet: 'ascii',
    collation: 'ascii_bin',
    defaultValue: null,
  },
  {
    table: 'products',
    column: 'listing_request_id',
    columnType: 'varchar(101)',
    nullable: 'YES',
    characterSet: 'ascii',
    collation: 'ascii_bin',
    defaultValue: null,
  },
  {
    table: 'products',
    column: 'listing_request_fingerprint',
    columnType: 'varchar(65)',
    nullable: 'YES',
    characterSet: 'ascii',
    collation: 'ascii_bin',
    defaultValue: null,
  },
  {
    table: 'products',
    column: 'deleted_at',
    columnType: 'timestamp(6)',
    nullable: 'YES',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
] as const satisfies readonly ColumnDefinition[];

const AUDIT_TABLES = PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS;

const FIXED_BUSINESS_COLUMNS = [
  {
    table: 'products',
    column: 'price',
    columnType: 'int unsigned',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: 'products',
    column: 'stock',
    columnType: 'int unsigned',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: 'products',
    column: 'category',
    columnType: 'varchar(32)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    defaultValue: null,
  },
  {
    table: 'products',
    column: 'theme',
    columnType: 'varchar(32)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    defaultValue: null,
  },
  {
    table: 'products',
    column: 'created_at',
    columnType: 'timestamp',
    nullable: 'YES',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: 'products',
    column: 'updated_at',
    columnType: 'timestamp',
    nullable: 'YES',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: 'purchase_transactions',
    column: 'source',
    columnType: 'varchar(32)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    defaultValue: null,
  },
  {
    table: 'purchase_transactions',
    column: 'amount',
    columnType: 'int unsigned',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: 'purchase_transactions',
    column: 'status',
    columnType: 'varchar(32)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    defaultValue: null,
  },
  {
    table: 'purchase_transactions',
    column: 'created_at',
    columnType: 'timestamp',
    nullable: 'YES',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: 'purchase_transactions',
    column: 'updated_at',
    columnType: 'timestamp',
    nullable: 'YES',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
] as const satisfies readonly ColumnDefinition[];

const FINAL_ID_COLUMNS = [
  ['users', 'user_id', 'varchar(255)', 'NO'],
  ['stores', 'store_id', 'varchar(255)', 'NO'],
  ['stores', 'user_id', 'varchar(255)', 'NO'],
  ['products', 'product_id', 'varchar(255)', 'NO'],
  ['products', 'store_id', 'varchar(255)', 'NO'],
  ['products', 'user_id', 'varchar(255)', 'NO'],
  ['purchase_transactions', 'transaction_id', 'varchar(255)', 'NO'],
  ['purchase_transactions', 'product_id', 'varchar(255)', 'NO'],
  ['purchase_transactions', 'buyer_user_id', 'varchar(255)', 'NO'],
  ['purchase_transactions', 'seller_user_id', 'varchar(255)', 'NO'],
] as const;

const LEGACY_ID_COLUMNS = [
  ['users', 'id'],
  ['stores', 'id'],
  ['stores', 'owner_id'],
  ['products', 'id'],
  ['products', 'seller_id'],
  ['purchase_transactions', 'id'],
  ['purchase_transactions', 'buyer_id'],
  ['purchase_transactions', 'seller_id'],
] as const;

const INDEXES = [
  {
    table: 'products',
    name: 'products_user_id_listing_request_id_unique',
    columns: ['user_id', 'listing_request_id'],
    unique: true,
  },
  {
    table: 'products',
    name: 'products_product_id_user_id_unique',
    columns: ['product_id', 'user_id'],
    unique: true,
  },
  {
    table: 'products',
    name: 'products_public_list_index',
    columns: ['deleted_at', 'created_at'],
    unique: false,
  },
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_product_id_unique',
    columns: ['product_id'],
    unique: true,
  },
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_product_seller',
    columns: ['product_id', 'seller_user_id'],
    unique: false,
  },
] as const satisfies readonly IndexDefinition[];

const LEGACY_PRODUCT_INDEX: IndexDefinition = {
  table: 'purchase_transactions',
  name: 'purchase_transactions_product_id_index',
  columns: ['product_id'],
  unique: false,
};

const FOREIGN_KEYS = [
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_product_seller_foreign',
    columns: ['product_id', 'seller_user_id'],
    referencedTable: 'products',
    referencedColumns: ['product_id', 'user_id'],
    deleteRule: 'RESTRICT',
    updateRule: 'RESTRICT',
  },
] as const satisfies readonly ForeignKeyDefinition[];

const PRESERVED_FOREIGN_KEYS = [
  {
    table: 'products',
    name: 'products_store_id_foreign',
    columns: ['store_id'],
    referencedTable: 'stores',
    referencedColumns: ['store_id'],
    deleteRule: 'RESTRICT',
    updateRule: 'RESTRICT',
  },
  {
    table: 'products',
    name: 'products_user_id_foreign',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['user_id'],
    deleteRule: 'RESTRICT',
    updateRule: 'RESTRICT',
  },
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_product_id_foreign',
    columns: ['product_id'],
    referencedTable: 'products',
    referencedColumns: ['product_id'],
    deleteRule: 'RESTRICT',
    updateRule: 'RESTRICT',
  },
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_buyer_user_id_foreign',
    columns: ['buyer_user_id'],
    referencedTable: 'users',
    referencedColumns: ['user_id'],
    deleteRule: 'RESTRICT',
    updateRule: 'RESTRICT',
  },
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_seller_user_id_foreign',
    columns: ['seller_user_id'],
    referencedTable: 'users',
    referencedColumns: ['user_id'],
    deleteRule: 'RESTRICT',
    updateRule: 'RESTRICT',
  },
] as const satisfies readonly ForeignKeyDefinition[];

// MySQL's $ anchor also matches immediately before a trailing line break.
// ICU's \A / \z are absolute. Hex expressions preserve their backslashes
// independently of the session's NO_BACKSLASH_ESCAPES setting.
const LISTING_REQUEST_ID_REGEXP_SQL =
  'CONVERT(0x5c415b412d5a612d7a302d392e5f3a2d5d7b312c3130307d5c7a USING utf8mb4) COLLATE utf8mb4_0900_bin';
const LISTING_REQUEST_ID_CHARACTERS_REGEXP_SQL =
  'CONVERT(0x5c415b412d5a612d7a302d392e5f3a2d5d2a5c7a USING utf8mb4) COLLATE utf8mb4_0900_bin';
const LISTING_REQUEST_FINGERPRINT_REGEXP_SQL =
  'CONVERT(0x5c415b302d39612d665d7b36347d5c7a USING utf8mb4) COLLATE utf8mb4_0900_bin';

const CHECKS = [
  {
    table: 'products',
    name: 'products_status_check',
    clause: "BINARY status IN ('available', 'sold')",
  },
  {
    table: 'products',
    name: 'products_price_check',
    clause: 'price BETWEEN 1 AND 99999999',
  },
  {
    table: 'products',
    name: 'products_category_check',
    clause:
      "BINARY category IN ('fashion', 'interior', 'hobby', 'accessory', 'tool')",
  },
  {
    table: 'products',
    name: 'products_theme_check',
    clause:
      "BINARY theme IN ('ocean', 'forest', 'amethyst', 'sunset', 'sand', 'moss')",
  },
  {
    table: 'products',
    name: 'products_listing_request_id_check',
    clause: `listing_request_id IS NULL OR listing_request_id REGEXP ${LISTING_REQUEST_ID_REGEXP_SQL}`,
  },
  {
    table: 'products',
    name: 'products_listing_request_fingerprint_check',
    clause: `listing_request_fingerprint IS NULL OR listing_request_fingerprint REGEXP ${LISTING_REQUEST_FINGERPRINT_REGEXP_SQL}`,
  },
  {
    table: 'products',
    name: 'products_listing_request_pair_check',
    clause:
      '((listing_request_id IS NULL AND listing_request_fingerprint IS NULL) OR (listing_request_id IS NOT NULL AND listing_request_fingerprint IS NOT NULL))',
  },
  {
    table: 'products',
    name: 'products_deleted_status_check',
    clause: "deleted_at IS NULL OR BINARY status = 'available'",
  },
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_distinct_users_check',
    clause: 'buyer_user_id <> seller_user_id',
  },
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_source_check',
    clause: "BINARY source IN ('web', 'minecraft')",
  },
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_status_check',
    clause: "BINARY status IN ('paid', 'shipping', 'complete')",
  },
  {
    table: 'purchase_transactions',
    name: 'purchase_transactions_amount_check',
    clause: 'amount BETWEEN 1 AND 99999999',
  },
] as const satisfies readonly CheckDefinition[];

const TRIGGERS = PRODUCT_STATUS_TRIGGER_CONTRACTS;

const snapshots = new WeakMap<MigrationExecutor, MigrationSnapshot>();

function assertColumnDefinition(
  row: ColumnRow | undefined,
  definition: ColumnDefinition,
): void {
  if (!row)
    unsafe(
      `Required column is missing: ${definition.table}.${definition.column}.`,
    );
  if (
    row.columnType.toLowerCase() !== definition.columnType ||
    row.isNullable !== definition.nullable ||
    (row.characterSetName?.toLowerCase() ?? null) !== definition.characterSet ||
    (row.collationName?.toLowerCase() ?? null) !== definition.collation ||
    row.columnDefault !== definition.defaultValue ||
    row.extra.trim() !== '' ||
    (row.generationExpression?.trim().length ?? 0) > 0
  ) {
    unsafe(
      `Unexpected definition for ${definition.table}.${definition.column}.`,
    );
  }
}

async function inspectAuditTables(
  db: SqlExecutor,
  databaseName: string,
): Promise<Set<string>> {
  const expectedNames = AUDIT_TABLES.map(({ name }) => name);
  const tableRows = await db.query<TableRow>(
    `SELECT TABLE_NAME AS tableName, ENGINE AS engine,
            TABLE_COLLATION AS tableCollation
       FROM information_schema.tables
      WHERE table_schema = ?
        AND table_name IN (${expectedNames.map(() => '?').join(', ')})`,
    [databaseName, ...expectedNames],
  );
  const present = new Set(tableRows.map(({ tableName }) => tableName));
  if (present.size === 0) return present;

  const columnRows = await db.query<ColumnRow>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
            COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
            CHARACTER_SET_NAME AS characterSetName,
            COLLATION_NAME AS collationName, COLUMN_DEFAULT AS columnDefault,
            EXTRA AS extra, GENERATION_EXPRESSION AS generationExpression
       FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name IN (${expectedNames.map(() => '?').join(', ')})`,
    [databaseName, ...expectedNames],
  );
  const indexRows = await db.query<IndexRow>(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
            NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
            COLUMN_NAME AS columnName, IS_VISIBLE AS isVisible,
            EXPRESSION AS expression, SUB_PART AS subPart,
            COLLATION AS collation, INDEX_TYPE AS indexType
       FROM information_schema.statistics
      WHERE table_schema = ?
        AND table_name IN (${expectedNames.map(() => '?').join(', ')})
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [databaseName, ...expectedNames],
  );
  const indexes = groupIndexes(indexRows);
  const constraintRows = await db.query<TableConstraintRow>(
    `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
            CONSTRAINT_TYPE AS constraintType
       FROM information_schema.table_constraints
      WHERE constraint_schema = ?
        AND table_name IN (${expectedNames.map(() => '?').join(', ')})
        AND constraint_type IN ('FOREIGN KEY', 'CHECK')`,
    [databaseName, ...expectedNames],
  );
  const triggerRows = await db.query<AuditTriggerRow>(
    `SELECT TRIGGER_NAME AS triggerName,
            EVENT_OBJECT_TABLE AS eventObjectTable
       FROM information_schema.triggers
      WHERE trigger_schema = ?
        AND event_object_table IN (${expectedNames.map(() => '?').join(', ')})`,
    [databaseName, ...expectedNames],
  );
  const unexpectedConstraint = constraintRows[0];
  if (unexpectedConstraint) {
    unsafe(
      `Unexpected ${unexpectedConstraint.constraintType.toLowerCase()} on audit table ${unexpectedConstraint.tableName}: ${unexpectedConstraint.constraintName}.`,
    );
  }
  const unexpectedTrigger = triggerRows[0];
  if (unexpectedTrigger) {
    unsafe(
      `Unexpected trigger on audit table ${unexpectedTrigger.eventObjectTable}: ${unexpectedTrigger.triggerName}.`,
    );
  }

  for (const definition of AUDIT_TABLES) {
    if (!present.has(definition.name)) continue;
    const table = tableRows.find(
      ({ tableName }) => tableName === definition.name,
    );
    if (
      table?.engine?.toLowerCase() !== definition.engine ||
      table.tableCollation?.toLowerCase() !== definition.tableCollation
    ) {
      unsafe(`Unexpected definition for audit table ${definition.name}.`);
    }
    const actualColumns = columnRows.filter(
      ({ tableName }) => tableName === definition.name,
    );
    if (actualColumns.length !== definition.columns.length) {
      unsafe(`Unexpected columns in audit table ${definition.name}.`);
    }
    for (const column of definition.columns) {
      assertColumnDefinition(
        actualColumns.find(({ columnName }) => columnName === column.column),
        column,
      );
    }
    const tableIndexes = indexes.filter(
      ({ tableName }) => tableName === definition.name,
    );
    if (
      tableIndexes.length !== 1 ||
      tableIndexes[0]?.indexName !== 'PRIMARY' ||
      !tableIndexes[0].unique ||
      !tableIndexes[0].visible ||
      !tableIndexes[0].plainAscendingBtree ||
      !sameColumns(tableIndexes[0].columns, definition.primaryKey)
    ) {
      unsafe(`Unexpected indexes in audit table ${definition.name}.`);
    }
  }
  return present;
}

function assertFinalEntityIdColumns(columns: ReadonlyMap<string, ColumnRow>) {
  for (const [table, column, columnType, nullable] of FINAL_ID_COLUMNS) {
    const row = columns.get(columnKey(table, column));
    if (
      !row ||
      row.columnType.toLowerCase() !== columnType ||
      row.isNullable !== nullable ||
      row.characterSetName?.toLowerCase() !== 'utf8mb4' ||
      row.collationName?.toLowerCase() !== 'utf8mb4_unicode_ci' ||
      row.columnDefault !== null ||
      row.extra.trim() !== '' ||
      (row.generationExpression?.trim().length ?? 0) > 0
    ) {
      unsafe(
        `The final #114 column is missing or invalid: ${table}.${column}.`,
      );
    }
  }
  for (const [table, column] of LEGACY_ID_COLUMNS) {
    if (columns.has(columnKey(table, column))) {
      unsafe(`Legacy #114 column still exists: ${table}.${column}.`);
    }
  }
}

function inspectProductColumns(
  columns: ReadonlyMap<string, ColumnRow>,
): boolean {
  const present = PRODUCT_COLUMNS.filter((definition) =>
    columns.has(columnKey(definition.table, definition.column)),
  );
  if (present.length !== 0 && present.length !== PRODUCT_COLUMNS.length) {
    unsafe('Product status columns are in an unknown partial state.');
  }
  if (present.length === 0) return false;
  for (const definition of PRODUCT_COLUMNS) {
    assertColumnDefinition(
      columns.get(columnKey(definition.table, definition.column)),
      definition,
    );
  }
  return true;
}

function inspectRequestIdColumn(
  columns: ReadonlyMap<string, ColumnRow>,
): boolean {
  const row = columns.get(columnKey('purchase_transactions', 'request_id'));
  if (
    !row ||
    row.columnType.toLowerCase() !== 'varchar(255)' ||
    row.isNullable !== 'NO' ||
    row.characterSetName?.toLowerCase() !== 'utf8mb4' ||
    row.columnDefault !== null ||
    row.extra.trim() !== '' ||
    (row.generationExpression?.trim().length ?? 0) > 0
  ) {
    unsafe('purchase_transactions.request_id has an unexpected definition.');
  }
  const collation = row.collationName?.toLowerCase();
  if (collation === 'utf8mb4_unicode_ci') return false;
  if (collation === 'utf8mb4_0900_bin') return true;
  return unsafe(
    'purchase_transactions.request_id has an unsupported collation.',
  );
}

function validateNamedIndex(
  indexes: readonly GroupedIndex[],
  definition: IndexDefinition,
): GroupedIndex | undefined {
  const named = indexes.find(
    (index) =>
      index.tableName === definition.table &&
      index.indexName === definition.name,
  );
  if (
    named &&
    (named.unique !== definition.unique ||
      !named.visible ||
      !named.plainAscendingBtree ||
      !sameColumns(named.columns, definition.columns))
  ) {
    unsafe(`Index name collision: ${definition.table}.${definition.name}.`);
  }
  return named;
}

function validateIndexes(indexes: readonly GroupedIndex[]): void {
  for (const definition of INDEXES) validateNamedIndex(indexes, definition);
  const legacyProductIndex = validateNamedIndex(indexes, LEGACY_PRODUCT_INDEX);
  const finalProductIndex = validateNamedIndex(
    indexes,
    INDEXES.find(
      ({ name }) => name === 'purchase_transactions_product_id_unique',
    )!,
  );
  if (!legacyProductIndex && !finalProductIndex) {
    unsafe(
      'Neither the legacy nor final purchase transaction product index exists.',
    );
  }

  for (const definition of INDEXES) {
    const semantic = indexes.filter(
      (index) =>
        index.tableName === definition.table &&
        index.unique === definition.unique &&
        index.visible &&
        index.plainAscendingBtree &&
        sameColumns(index.columns, definition.columns),
    );
    if (semantic.some((index) => index.indexName !== definition.name)) {
      unsafe(
        `Unexpected equivalent index for ${definition.table}.${definition.name}.`,
      );
    }
  }
}

function validateForeignKeys(
  foreignKeys: readonly GroupedForeignKey[],
  databaseName: string,
): void {
  const expectedNames = new Set<string>([
    ...PRESERVED_FOREIGN_KEYS.map(({ name }) => name),
    ...FOREIGN_KEYS.map(({ name }) => name),
  ]);
  const unexpected = foreignKeys.find(
    (foreignKey) =>
      ['products', 'purchase_transactions'].includes(foreignKey.tableName) &&
      !expectedNames.has(foreignKey.constraintName),
  );
  if (unexpected) {
    unsafe(
      `Unexpected pre-existing foreign key: ${unexpected.tableName}.${unexpected.constraintName}.`,
    );
  }

  const validate = (
    definition: ForeignKeyDefinition,
    required: boolean,
  ): void => {
    const nameCollision = foreignKeys.find(
      (foreignKey) =>
        foreignKey.constraintName === definition.name &&
        foreignKey.tableName !== definition.table,
    );
    if (nameCollision) {
      unsafe(`Foreign key name collision: ${definition.name}.`);
    }
    const named = foreignKeys.find(
      (foreignKey) =>
        foreignKey.tableName === definition.table &&
        foreignKey.constraintName === definition.name,
    );
    if (
      named &&
      (named.constraintSchema !== databaseName ||
        named.tableSchema !== databaseName ||
        !sameColumns(named.columns, definition.columns) ||
        named.referencedTableSchema !== databaseName ||
        named.referencedTableName !== definition.referencedTable ||
        !sameColumns(named.referencedColumns, definition.referencedColumns) ||
        named.deleteRule !== definition.deleteRule ||
        !sameUpdateRule(named.updateRule, definition.updateRule))
    ) {
      unsafe(`Foreign key name collision: ${definition.name}.`);
    }
    if (!named && required) {
      unsafe(`Required #114 foreign key is missing: ${definition.name}.`);
    }
    const semantic = foreignKeys.filter(
      (foreignKey) =>
        foreignKey.tableName === definition.table &&
        sameColumns(foreignKey.columns, definition.columns) &&
        foreignKey.referencedTableName === definition.referencedTable &&
        sameColumns(foreignKey.referencedColumns, definition.referencedColumns),
    );
    if (
      semantic.some(
        (foreignKey) => foreignKey.constraintName !== definition.name,
      )
    ) {
      unsafe(`Unexpected equivalent foreign key for ${definition.name}.`);
    }
  };

  for (const definition of PRESERVED_FOREIGN_KEYS) {
    validate(definition, true);
  }
  for (const definition of FOREIGN_KEYS) {
    validate(definition, false);
  }
}

function stripOuterParentheses(value: string): string {
  let result = value.trim();
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0;
    let quoted = false;
    let wrapsWholeExpression = true;
    for (let index = 0; index < result.length; index++) {
      if (result[index] === "'") {
        if (quoted && result[index + 1] === "'") {
          index += 1;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (result[index] === '(') depth++;
      if (result[index] === ')') depth--;
      if (depth === 0 && index < result.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function normalizeOutsideQuotedLiterals(value: string): string {
  let result = '';
  let quoted = false;
  let pendingWhitespace = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "'") {
      if (!quoted) {
        result = result.replace(/_[a-z0-9]+$/i, '');
        if (pendingWhitespace && result.length > 0 && !result.endsWith(' ')) {
          result += ' ';
        }
        pendingWhitespace = false;
        quoted = true;
        result += character;
        continue;
      }
      result += character;
      if (value[index + 1] === "'") {
        result += value[index + 1];
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (quoted) {
      result += character;
      continue;
    }
    if (character === '`') continue;
    if (/\s/.test(character)) {
      pendingWhitespace = true;
      continue;
    }
    if (pendingWhitespace && result.length > 0 && !result.endsWith(' ')) {
      result += ' ';
    }
    pendingWhitespace = false;
    result += character.toLowerCase();
  }
  return result.trim().replace(/;+$/g, '');
}

function removeUnquotedWhitespace(value: string): string {
  let result = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "'") {
      result += character;
      if (quoted && value[index + 1] === "'") {
        result += value[index + 1];
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && /\s/.test(character)) continue;
    result += character;
  }
  return result;
}

/** Match MySQL's CHECK_CLAUSE serialization without changing literal values. */
function escapeExpectedLiteralBackslashes(value: string): string {
  let result = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "'") {
      result += character;
      if (quoted && value[index + 1] === "'") {
        result += value[index + 1];
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (quoted && character === '\\') result += '\\';
    result += character;
  }
  return result;
}

function normalizeCheckSql(value: string): string {
  return normalizeOutsideQuotedLiterals(value.replaceAll("\\'", "'"))
    .replace(/cast\(([^()]*)\s+as\s+char\s+charset\s+binary\)/g, 'binary $1')
    .replace(
      /regexp_like\(([^,]+),\s*\((convert\(0x[0-9a-f]+\s+using\s+[a-z0-9_]+\)\s+collate\s+[a-z0-9_]+)\)\)/g,
      '$1 regexp $2',
    )
    .replace(
      /regexp_like\(([^,]+),\s*(convert\(0x[0-9a-f]+\s+using\s+[a-z0-9_]+\))\)/g,
      '$1 regexp $2',
    )
    .replace(/regexp_like\(([^,]+),\s*('[^']*')\)/g, '$1 regexp $2');
}

function splitTopLevelLogical(value: string, operator: 'and' | 'or'): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  let betweenNeedsAnd = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'") {
      if (quoted && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || !/[a-z]/.test(character ?? '')) continue;
    const previous = value[index - 1];
    if (previous && /[a-z0-9_]/.test(previous)) continue;

    let end = index + 1;
    while (end < value.length && /[a-z0-9_]/.test(value[end] ?? '')) {
      end += 1;
    }
    const word = value.slice(index, end);
    if (word === 'between') {
      betweenNeedsAnd = true;
    } else if (word === 'and' && betweenNeedsAnd) {
      betweenNeedsAnd = false;
    } else if (word === operator) {
      parts.push(value.slice(start, index).trim());
      start = end;
    }
    index = end - 1;
  }

  if (parts.length === 0) return [value.trim()];
  parts.push(value.slice(start).trim());
  return parts;
}

function canonicalCheckExpression(value: string): string {
  const expression = stripOuterParentheses(value);
  const orParts = splitTopLevelLogical(expression, 'or');
  if (orParts.length > 1) {
    return `or(${orParts.map(canonicalCheckExpression).join(',')})`;
  }
  const andParts = splitTopLevelLogical(expression, 'and');
  if (andParts.length > 1) {
    return `and(${andParts.map(canonicalCheckExpression).join(',')})`;
  }
  return `atom(${removeUnquotedWhitespace(expression)})`;
}

function sameCheckClause(actual: string, expected: string): boolean {
  return (
    canonicalCheckExpression(normalizeCheckSql(actual)) ===
    canonicalCheckExpression(
      normalizeCheckSql(escapeExpectedLiteralBackslashes(expected)),
    )
  );
}

function validateChecks(checks: readonly CheckRow[]): void {
  const expectedNames = new Set<string>(CHECKS.map(({ name }) => name));
  const unexpected = checks.find(
    (check) =>
      ['products', 'purchase_transactions'].includes(check.tableName) &&
      !expectedNames.has(check.constraintName),
  );
  if (unexpected) {
    unsafe(
      `Unexpected pre-existing check constraint: ${unexpected.tableName}.${unexpected.constraintName}.`,
    );
  }
  for (const definition of CHECKS) {
    const nameCollision = checks.find(
      (check) =>
        check.constraintName === definition.name &&
        check.tableName !== definition.table,
    );
    if (nameCollision) {
      unsafe(`Check constraint name collision: ${definition.name}.`);
    }
    const named = checks.find(
      (check) =>
        check.tableName === definition.table &&
        check.constraintName === definition.name,
    );
    if (
      named &&
      (named.enforced !== 'YES' ||
        !sameCheckClause(named.checkClause, definition.clause))
    ) {
      unsafe(`Check constraint name collision: ${definition.name}.`);
    }
  }
}

function validateTriggers(triggers: readonly TriggerRow[]): void {
  const expectedNames = new Set<string>(TRIGGERS.map(({ name }) => name));
  const expectedTables = new Set<string>(TRIGGERS.map(({ table }) => table));
  const unexpected = triggers.find(
    (trigger) =>
      expectedTables.has(trigger.eventObjectTable) &&
      !expectedNames.has(trigger.triggerName),
  );
  if (unexpected) {
    unsafe(
      `Unexpected pre-existing ${unexpected.eventObjectTable} trigger: ${unexpected.triggerName}.`,
    );
  }
  for (const definition of TRIGGERS) {
    const named = triggers.find(
      (trigger) => trigger.triggerName === definition.name,
    );
    if (
      named &&
      (named.eventObjectTable !== definition.table ||
        named.eventManipulation !== definition.event ||
        named.actionTiming !== definition.timing ||
        named.actionOrientation !== definition.orientation ||
        normalizeTriggerStatement(named.actionStatement) !==
          normalizeTriggerStatement(definition.statement))
    ) {
      unsafe(`Trigger name collision: ${definition.name}.`);
    }
  }
}

async function inspectSchema(
  db: MigrationExecutor,
): Promise<ProductStatusSchema> {
  const [current] = await db.query<CurrentDatabaseRow>(
    'SELECT DATABASE() AS databaseName',
  );
  if (!current?.databaseName) unsafe('A database must be selected.');

  const readiness = await inspectDatabaseReadiness(
    db,
    current.databaseName,
    ENTITY_ID_SCHEMA_REQUIREMENTS,
  );
  const problems = readinessProblems(readiness);
  if (problems.length > 0) {
    unsafe(`The #114 schema is not ready: ${problems.join('; ')}`);
  }

  const columnRows = await db.query<ColumnRow>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
            COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
            CHARACTER_SET_NAME AS characterSetName,
            COLLATION_NAME AS collationName, COLUMN_DEFAULT AS columnDefault,
            EXTRA AS extra, GENERATION_EXPRESSION AS generationExpression
       FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name IN ('users', 'stores', 'products', 'purchase_transactions')`,
    [current.databaseName],
  );
  const columns = new Map(
    columnRows.map((row) => [columnKey(row.tableName, row.columnName), row]),
  );
  assertFinalEntityIdColumns(columns);
  for (const definition of FIXED_BUSINESS_COLUMNS) {
    assertColumnDefinition(
      columns.get(columnKey(definition.table, definition.column)),
      definition,
    );
  }
  const productColumnsPresent = inspectProductColumns(columns);
  const requestIdFinal = inspectRequestIdColumn(columns);

  const indexRows = await db.query<IndexRow>(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
            NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
            COLUMN_NAME AS columnName, IS_VISIBLE AS isVisible,
            EXPRESSION AS expression, SUB_PART AS subPart,
            COLLATION AS collation, INDEX_TYPE AS indexType
       FROM information_schema.statistics
      WHERE table_schema = ?
        AND table_name IN ('products', 'purchase_transactions')
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [current.databaseName],
  );
  const indexes = groupIndexes(indexRows);
  validateIndexes(indexes);

  const foreignKeyRows = await db.query<ForeignKeyRow>(
    `SELECT kcu.CONSTRAINT_SCHEMA AS constraintSchema,
            kcu.TABLE_SCHEMA AS tableSchema, kcu.TABLE_NAME AS tableName,
            kcu.CONSTRAINT_NAME AS constraintName,
            kcu.COLUMN_NAME AS columnName,
            kcu.REFERENCED_TABLE_SCHEMA AS referencedTableSchema,
            kcu.REFERENCED_TABLE_NAME AS referencedTableName,
            kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
            kcu.ORDINAL_POSITION AS sequence,
            rc.DELETE_RULE AS deleteRule, rc.UPDATE_RULE AS updateRule
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.TABLE_NAME = kcu.TABLE_NAME
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.TABLE_SCHEMA = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    [current.databaseName],
  );
  const foreignKeys = groupForeignKeys(foreignKeyRows);
  validateForeignKeys(foreignKeys, current.databaseName);

  const checks = await db.query<CheckRow>(
    `SELECT tc.TABLE_NAME AS tableName,
            tc.CONSTRAINT_NAME AS constraintName,
            cc.CHECK_CLAUSE AS checkClause, tc.ENFORCED AS enforced
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`,
    [current.databaseName],
  );
  validateChecks(checks);

  const triggers = await db.query<TriggerRow>(
    `SELECT TRIGGER_NAME AS triggerName,
            EVENT_OBJECT_TABLE AS eventObjectTable,
            EVENT_MANIPULATION AS eventManipulation,
            ACTION_TIMING AS actionTiming,
            ACTION_ORIENTATION AS actionOrientation,
            ACTION_STATEMENT AS actionStatement
       FROM information_schema.triggers WHERE trigger_schema = ?`,
    [current.databaseName],
  );
  validateTriggers(triggers);

  return {
    databaseName: current.databaseName,
    columns,
    indexes,
    foreignKeys,
    checks,
    triggers,
    productColumnsPresent,
    requestIdFinal,
  };
}

async function assertNoRows(
  db: SqlExecutor,
  description: string,
  sql: string,
): Promise<void> {
  const rows = await db.query<IdRow>(`${sql} LIMIT 20`);
  if (rows.length > 0) {
    unsafe(
      `${description}: ${rows.map(({ id }) => id).join(', ')}${rows.length === 20 ? ' (first 20)' : ''}.`,
    );
  }
}

async function inspectPopulation(
  db: SqlExecutor,
): Promise<StatusPopulationRow> {
  const [row] = await db.query<StatusPopulationRow>(
    `SELECT COUNT(*) AS total, COUNT(*) - COUNT(status) AS nullCount
       FROM products`,
  );
  return row ?? { total: 0, nullCount: 0 };
}

async function assertBaseDataSafe(db: SqlExecutor): Promise<void> {
  await assertNoRows(
    db,
    'Products reference a missing store or user',
    `SELECT p.product_id AS id
       FROM products p
       LEFT JOIN stores s ON s.store_id = p.store_id
       LEFT JOIN users u ON u.user_id = p.user_id
      WHERE s.store_id IS NULL OR u.user_id IS NULL`,
  );
  await assertNoRows(
    db,
    'Products violate the final price, category or theme contract',
    `SELECT product_id AS id FROM products
      WHERE price NOT BETWEEN 1 AND 99999999
         OR BINARY category NOT IN ('fashion', 'interior', 'hobby', 'accessory', 'tool')
         OR BINARY theme NOT IN ('ocean', 'forest', 'amethyst', 'sunset', 'sand', 'moss')`,
  );
  await assertNoRows(
    db,
    'Products have more than one purchase transaction',
    `SELECT product_id AS id FROM purchase_transactions
      GROUP BY product_id HAVING COUNT(*) > 1`,
  );
  await assertNoRows(
    db,
    'Transactions reference a missing product, buyer or seller',
    `SELECT t.transaction_id AS id
       FROM purchase_transactions t
       LEFT JOIN products p ON p.product_id = t.product_id
       LEFT JOIN users b ON b.user_id = t.buyer_user_id
       LEFT JOIN users s ON s.user_id = t.seller_user_id
      WHERE p.product_id IS NULL OR b.user_id IS NULL OR s.user_id IS NULL`,
  );
  await assertNoRows(
    db,
    'Transaction seller does not match the product seller',
    `SELECT t.transaction_id AS id
       FROM purchase_transactions t
       JOIN products p ON p.product_id = t.product_id
      WHERE NOT (t.seller_user_id <=> p.user_id)`,
  );
  await assertNoRows(
    db,
    'Transactions violate the final buyer, source, status or amount contract',
    `SELECT transaction_id AS id FROM purchase_transactions
      WHERE buyer_user_id = seller_user_id
         OR BINARY source NOT IN ('web', 'minecraft')
         OR BINARY status NOT IN ('paid', 'shipping', 'complete')
         OR amount NOT BETWEEN 1 AND 99999999`,
  );
}

async function assertProductStatusDataSafe(
  db: SqlExecutor,
  requirePopulated: boolean,
): Promise<ProductStatusPopulationState> {
  await assertNoRows(
    db,
    'Products contain invalid listing request metadata',
    `SELECT product_id AS id FROM products
      WHERE (listing_request_id IS NULL) <> (listing_request_fingerprint IS NULL)
         OR (listing_request_id IS NOT NULL
             AND listing_request_id NOT REGEXP ${LISTING_REQUEST_ID_REGEXP_SQL})
         OR (listing_request_fingerprint IS NOT NULL
             AND listing_request_fingerprint NOT REGEXP ${LISTING_REQUEST_FINGERPRINT_REGEXP_SQL})`,
  );
  await assertNoRows(
    db,
    'Products reuse a listing request ID for the same user',
    `SELECT MIN(product_id) AS id FROM products
      WHERE listing_request_id IS NOT NULL
      GROUP BY user_id, listing_request_id HAVING COUNT(*) > 1`,
  );

  const population = await inspectPopulation(db);
  const total = Number(population.total);
  const nullCount = Number(population.nullCount);
  if (nullCount !== 0 && nullCount !== total) {
    unsafe('Product status backfill is in an unknown partial state.');
  }
  if (requirePopulated && nullCount !== 0) {
    unsafe('Product status backfill is incomplete.');
  }
  if (total === 0) return 'empty';
  if (nullCount === total && total > 0) {
    await assertNoRows(
      db,
      'Products have new-writer metadata before status backfill',
      `SELECT product_id AS id FROM products
        WHERE listing_request_id IS NOT NULL
           OR listing_request_fingerprint IS NOT NULL
           OR deleted_at IS NOT NULL`,
    );
    return 'unpopulated';
  }

  await assertNoRows(
    db,
    'Products contain an invalid status or stock pair',
    `SELECT product_id AS id FROM products
      WHERE status IS NULL
         OR NOT (
           (BINARY status = 'available' AND stock = 1)
           OR (BINARY status = 'sold' AND stock = 0)
         )`,
  );
  await assertNoRows(
    db,
    'A product with a transaction is not sold',
    `SELECT p.product_id AS id
       FROM products p
       JOIN purchase_transactions t ON t.product_id = p.product_id
      WHERE BINARY p.status <> 'sold' OR p.stock <> 0`,
  );
  await assertNoRows(
    db,
    'A deleted product is not available',
    `SELECT product_id AS id FROM products
      WHERE deleted_at IS NOT NULL AND BINARY status <> 'available'`,
  );
  return 'populated';
}

async function readSnapshot(db: SqlExecutor): Promise<MigrationSnapshot> {
  const [products] = await db.query<ProductAuditRow>(
    `SELECT COUNT(*) AS productCount, COALESCE(SUM(price), 0) AS totalPrice,
            SUM(stock = 0) AS zeroStockCount,
            SUM(stock = 1) AS oneStockCount,
            SUM(stock >= 2) AS multipleStockCount
       FROM products`,
  );
  const [transactions] = await db.query<TransactionAuditRow>(
    `SELECT COUNT(*) AS transactionCount,
            COALESCE(SUM(amount), 0) AS totalAmount
       FROM purchase_transactions`,
  );
  return {
    productCount: String(products?.productCount ?? 0),
    totalPrice: String(products?.totalPrice ?? 0),
    transactionCount: String(transactions?.transactionCount ?? 0),
    totalAmount: String(transactions?.totalAmount ?? 0),
  };
}

async function ensureAuditTables(db: MigrationExecutor): Promise<void> {
  const [current] = await db.query<CurrentDatabaseRow>(
    'SELECT DATABASE() AS databaseName',
  );
  if (!current?.databaseName) unsafe('A database must be selected.');

  let present = await inspectAuditTables(db, current.databaseName);
  for (const definition of AUDIT_TABLES) {
    if (present.has(definition.name)) continue;
    await db.execute(definition.createSql);
    present = await inspectAuditTables(db, current.databaseName);
  }
}

async function addProductColumns(db: MigrationExecutor): Promise<void> {
  const schema = await inspectSchema(db);
  if (schema.productColumnsPresent) return;
  await db.execute(`ALTER TABLE products
    ADD COLUMN status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL AFTER stock,
    ADD COLUMN listing_request_id VARCHAR(101) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL AFTER emoji,
    ADD COLUMN listing_request_fingerprint VARCHAR(65) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL AFTER listing_request_id,
    ADD COLUMN deleted_at TIMESTAMP(6) NULL DEFAULT NULL AFTER listing_request_fingerprint`);
}

async function createMissingTriggers(db: MigrationExecutor): Promise<void> {
  for (const definition of TRIGGERS) {
    const schema = await inspectSchema(db);
    if (
      schema.triggers.some((trigger) => trigger.triggerName === definition.name)
    ) {
      continue;
    }
    try {
      await db.execute(
        `CREATE TRIGGER \`${definition.name}\` ${definition.timing} ${definition.event}
           ON \`${definition.table}\` FOR EACH ROW ${definition.statement}`,
      );
    } catch (error) {
      if (isMysqlError(error, 'ER_TABLEACCESS_DENIED_ERROR', 1142)) {
        unsafe(
          `Could not create compatibility trigger ${definition.name}. Grant the migration account TRIGGER privilege on the target schema, directly or through an active role.`,
          error,
        );
      }
      if (isMysqlError(error, 'ER_BINLOG_CREATE_ROUTINE_NEED_SUPER', 1419)) {
        unsafe(
          `Could not create compatibility trigger ${definition.name} because binary logging requires an account with sufficient administrative privilege or GLOBAL log_bin_trust_function_creators = 1.`,
          error,
        );
      }
      throw error;
    }
  }
}

async function assertMigrationAuditDataSafe(db: SqlExecutor): Promise<void> {
  await assertNoRows(
    db,
    'The product stock migration audit is missing or inconsistent',
    `SELECT p.product_id AS id
       FROM products p
       LEFT JOIN purchase_transactions t ON t.product_id = p.product_id
       LEFT JOIN ${PRODUCT_STATUS_PRODUCT_AUDIT_TABLE} a
         ON a.product_id = p.product_id
      WHERE a.product_id IS NULL
         OR NOT (a.transaction_id <=> t.transaction_id)
         OR a.transaction_stock_anomaly <>
              IF(t.transaction_id IS NOT NULL AND a.original_stock > 0, 1, 0)
         OR (p.status IS NULL AND a.original_stock <> p.stock)
         OR (p.status IS NOT NULL AND (
              BINARY p.status <>
                CASE
                  WHEN a.transaction_id IS NOT NULL OR a.original_stock = 0
                    THEN 'sold'
                  ELSE 'available'
                END
              OR p.stock <>
                CASE
                  WHEN a.transaction_id IS NOT NULL OR a.original_stock = 0
                    THEN 0
                  ELSE 1
                END
            ))`,
  );
  await assertNoRows(
    db,
    'The product stock migration audit contains an unknown product',
    `SELECT a.product_id AS id
       FROM ${PRODUCT_STATUS_PRODUCT_AUDIT_TABLE} a
       LEFT JOIN products p ON p.product_id = a.product_id
      WHERE p.product_id IS NULL`,
  );
  await assertNoRows(
    db,
    'The grandfathered request ID audit is missing or inconsistent',
    `SELECT t.transaction_id AS id
       FROM purchase_transactions t
       LEFT JOIN ${PRODUCT_STATUS_REQUEST_AUDIT_TABLE} a
         ON a.transaction_id = t.transaction_id
      WHERE (CHAR_LENGTH(t.request_id) NOT BETWEEN 1 AND 100
          OR t.request_id COLLATE utf8mb4_0900_bin
               NOT REGEXP ${LISTING_REQUEST_ID_CHARACTERS_REGEXP_SQL})
        AND (
          a.transaction_id IS NULL
          OR BINARY a.request_id_sha256 <> BINARY SHA2(t.request_id, 256)
          OR a.request_id_character_length <> CHAR_LENGTH(t.request_id)
          OR a.violates_current_length_limit <>
               IF(CHAR_LENGTH(t.request_id) NOT BETWEEN 1 AND 100, 1, 0)
          OR a.contains_noncanonical_character <>
               IF(t.request_id COLLATE utf8mb4_0900_bin
                    NOT REGEXP ${LISTING_REQUEST_ID_CHARACTERS_REGEXP_SQL}, 1, 0)
        )`,
  );
  await assertNoRows(
    db,
    'The grandfathered request ID audit contains an unknown or canonical request',
    `SELECT a.transaction_id AS id
       FROM ${PRODUCT_STATUS_REQUEST_AUDIT_TABLE} a
      LEFT JOIN purchase_transactions t
         ON t.transaction_id = a.transaction_id
      WHERE t.transaction_id IS NULL
         OR (CHAR_LENGTH(t.request_id) BETWEEN 1 AND 100
         AND t.request_id COLLATE utf8mb4_0900_bin
               REGEXP ${LISTING_REQUEST_ID_CHARACTERS_REGEXP_SQL})`,
  );
}

async function captureAuditAndBackfillProductStatus(
  db: MigrationExecutor,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(`INSERT IGNORE INTO ${PRODUCT_STATUS_PRODUCT_AUDIT_TABLE}
      (product_id, original_stock, transaction_id,
       transaction_stock_anomaly, captured_at)
      SELECT p.product_id, p.stock, t.transaction_id,
             IF(t.transaction_id IS NOT NULL AND p.stock > 0, 1, 0),
             UTC_TIMESTAMP(6)
        FROM products p
        LEFT JOIN purchase_transactions t ON t.product_id = p.product_id
       WHERE p.status IS NULL`);
    await tx.execute(`INSERT IGNORE INTO ${PRODUCT_STATUS_REQUEST_AUDIT_TABLE}
      (transaction_id, request_id_sha256, request_id_character_length,
       violates_current_length_limit, contains_noncanonical_character,
       captured_at)
      SELECT transaction_id, SHA2(request_id, 256), CHAR_LENGTH(request_id),
             IF(CHAR_LENGTH(request_id) NOT BETWEEN 1 AND 100, 1, 0),
             IF(request_id COLLATE utf8mb4_0900_bin
                  NOT REGEXP ${LISTING_REQUEST_ID_CHARACTERS_REGEXP_SQL}, 1, 0),
             UTC_TIMESTAMP(6)
        FROM purchase_transactions
       WHERE CHAR_LENGTH(request_id) NOT BETWEEN 1 AND 100
          OR request_id COLLATE utf8mb4_0900_bin
               NOT REGEXP ${LISTING_REQUEST_ID_CHARACTERS_REGEXP_SQL}`);
    await assertMigrationAuditDataSafe(tx);
    await tx.execute(`UPDATE products p
      LEFT JOIN (
        SELECT product_id, COUNT(*) AS transaction_count
          FROM purchase_transactions GROUP BY product_id
      ) t ON t.product_id = p.product_id
      SET p.status = CASE
            WHEN COALESCE(t.transaction_count, 0) = 1 OR p.stock = 0
              THEN 'sold'
            ELSE 'available'
          END,
          p.stock = CASE
            WHEN COALESCE(t.transaction_count, 0) = 1 OR p.stock = 0
              THEN 0
            ELSE 1
          END`);
  });
}

async function addMissingIndexes(db: MigrationExecutor): Promise<void> {
  for (const definition of INDEXES) {
    const schema = await inspectSchema(db);
    if (validateNamedIndex(schema.indexes, definition)) continue;
    await db.execute(
      `ALTER TABLE \`${definition.table}\` ADD ${definition.unique ? 'UNIQUE ' : ''}INDEX \`${definition.name}\` (${definition.columns.map((column) => `\`${column}\``).join(', ')})`,
    );
  }

  const schema = await inspectSchema(db);
  if (validateNamedIndex(schema.indexes, LEGACY_PRODUCT_INDEX)) {
    await db.execute(
      `ALTER TABLE purchase_transactions DROP INDEX \`${LEGACY_PRODUCT_INDEX.name}\``,
    );
  }
}

async function finalizeRequestIdCollation(
  db: MigrationExecutor,
): Promise<void> {
  const schema = await inspectSchema(db);
  if (schema.requestIdFinal) return;
  await db.execute(`ALTER TABLE purchase_transactions
    MODIFY COLUMN request_id VARCHAR(255)
      CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL`);
}

async function addMissingChecks(db: MigrationExecutor): Promise<void> {
  for (const definition of CHECKS) {
    const schema = await inspectSchema(db);
    if (
      schema.checks.some(
        (check) =>
          check.tableName === definition.table &&
          check.constraintName === definition.name,
      )
    ) {
      continue;
    }
    await db.execute(
      `ALTER TABLE \`${definition.table}\` ADD CONSTRAINT \`${definition.name}\` CHECK (${definition.clause})`,
    );
  }
}

async function addMissingForeignKeys(db: MigrationExecutor): Promise<void> {
  for (const definition of FOREIGN_KEYS) {
    const schema = await inspectSchema(db);
    if (
      schema.foreignKeys.some(
        (foreignKey) => foreignKey.constraintName === definition.name,
      )
    ) {
      continue;
    }
    await db.execute(
      `ALTER TABLE \`${definition.table}\`
        ADD CONSTRAINT \`${definition.name}\`
        FOREIGN KEY (${definition.columns.map((column) => `\`${column}\``).join(', ')})
        REFERENCES \`${definition.referencedTable}\` (${definition.referencedColumns.map((column) => `\`${column}\``).join(', ')})
        ON DELETE ${definition.deleteRule} ON UPDATE ${definition.updateRule}`,
    );
  }
}

function requireFinalSchema(schema: ProductStatusSchema): void {
  if (!schema.productColumnsPresent)
    unsafe('Product status columns are missing.');
  if (!schema.requestIdFinal) {
    unsafe('purchase_transactions.request_id does not use utf8mb4_0900_bin.');
  }
  for (const definition of INDEXES) {
    if (!validateNamedIndex(schema.indexes, definition)) {
      unsafe(`Required index is missing: ${definition.name}.`);
    }
  }
  if (validateNamedIndex(schema.indexes, LEGACY_PRODUCT_INDEX)) {
    unsafe(`Legacy index still exists: ${LEGACY_PRODUCT_INDEX.name}.`);
  }
  for (const definition of FOREIGN_KEYS) {
    if (
      !schema.foreignKeys.some(
        (foreignKey) => foreignKey.constraintName === definition.name,
      )
    ) {
      unsafe(`Required foreign key is missing: ${definition.name}.`);
    }
  }
  for (const definition of CHECKS) {
    if (
      !schema.checks.some(
        (check) =>
          check.tableName === definition.table &&
          check.constraintName === definition.name,
      )
    ) {
      unsafe(`Required check constraint is missing: ${definition.name}.`);
    }
  }
  for (const definition of TRIGGERS) {
    if (
      !schema.triggers.some(
        (trigger) => trigger.triggerName === definition.name,
      )
    ) {
      unsafe(`Required compatibility trigger is missing: ${definition.name}.`);
    }
  }
}

export const productStatusMigration: Migration = {
  version: '0002_product_status',
  async preflight(db: MigrationExecutor): Promise<void> {
    const schema = await inspectSchema(db);
    const auditTables = await inspectAuditTables(db, schema.databaseName);
    await assertBaseDataSafe(db);
    if (schema.productColumnsPresent) {
      const population = await assertProductStatusDataSafe(db, false);
      if (population === 'populated') {
        if (auditTables.size !== AUDIT_TABLES.length) {
          unsafe(
            'Populated product status requires both complete migration audit tables.',
          );
        }
        await assertMigrationAuditDataSafe(db);
      }
    }
    snapshots.set(db, await readSnapshot(db));
  },
  async up(db: MigrationExecutor): Promise<void> {
    await ensureAuditTables(db);
    await addProductColumns(db);
    await createMissingTriggers(db);
    await captureAuditAndBackfillProductStatus(db);
    await addMissingIndexes(db);
    await finalizeRequestIdCollation(db);
    await addMissingChecks(db);
    await addMissingForeignKeys(db);
  },
  async verify(db: MigrationExecutor): Promise<void> {
    const schema = await inspectSchema(db);
    const auditTables = await inspectAuditTables(db, schema.databaseName);
    if (auditTables.size !== AUDIT_TABLES.length) {
      unsafe('The product status migration audit tables are missing.');
    }
    requireFinalSchema(schema);
    await assertBaseDataSafe(db);
    await assertProductStatusDataSafe(db, true);
    await assertMigrationAuditDataSafe(db);

    const before = snapshots.get(db);
    const after = await readSnapshot(db);
    snapshots.delete(db);
    if (
      before &&
      (before.productCount !== after.productCount ||
        before.totalPrice !== after.totalPrice ||
        before.transactionCount !== after.transactionCount ||
        before.totalAmount !== after.totalAmount)
    ) {
      unsafe('Product or transaction identity data changed during migration.');
    }
  },
};
