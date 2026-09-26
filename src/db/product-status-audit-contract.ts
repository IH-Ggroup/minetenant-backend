export interface ProductStatusAuditColumnContract {
  table: string;
  column: string;
  columnType: string;
  nullable: 'YES' | 'NO';
  characterSet: string | null;
  collation: string | null;
  defaultValue: string | null;
}

export interface ProductStatusAuditTableContract {
  name: string;
  engine: 'innodb';
  tableCollation: 'utf8mb4_unicode_ci';
  columns: readonly ProductStatusAuditColumnContract[];
  primaryKey: readonly string[];
  createSql: string;
}

export const PRODUCT_STATUS_PRODUCT_AUDIT_TABLE =
  'product_status_migration_product_audit';
export const PRODUCT_STATUS_REQUEST_AUDIT_TABLE =
  'product_status_migration_request_audit';

const PRODUCT_AUDIT_COLUMNS = [
  {
    table: PRODUCT_STATUS_PRODUCT_AUDIT_TABLE,
    column: 'product_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    defaultValue: null,
  },
  {
    table: PRODUCT_STATUS_PRODUCT_AUDIT_TABLE,
    column: 'original_stock',
    columnType: 'int unsigned',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: PRODUCT_STATUS_PRODUCT_AUDIT_TABLE,
    column: 'transaction_id',
    columnType: 'varchar(255)',
    nullable: 'YES',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    defaultValue: null,
  },
  {
    table: PRODUCT_STATUS_PRODUCT_AUDIT_TABLE,
    column: 'transaction_stock_anomaly',
    columnType: 'tinyint unsigned',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: PRODUCT_STATUS_PRODUCT_AUDIT_TABLE,
    column: 'captured_at',
    columnType: 'timestamp(6)',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
] as const satisfies readonly ProductStatusAuditColumnContract[];

const REQUEST_AUDIT_COLUMNS = [
  {
    table: PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
    column: 'transaction_id',
    columnType: 'varchar(255)',
    nullable: 'NO',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    defaultValue: null,
  },
  {
    table: PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
    column: 'request_id_sha256',
    columnType: 'char(64)',
    nullable: 'NO',
    characterSet: 'ascii',
    collation: 'ascii_bin',
    defaultValue: null,
  },
  {
    table: PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
    column: 'request_id_character_length',
    columnType: 'smallint unsigned',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
    column: 'violates_current_length_limit',
    columnType: 'tinyint unsigned',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
    column: 'contains_noncanonical_character',
    columnType: 'tinyint unsigned',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
  {
    table: PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
    column: 'captured_at',
    columnType: 'timestamp(6)',
    nullable: 'NO',
    characterSet: null,
    collation: null,
    defaultValue: null,
  },
] as const satisfies readonly ProductStatusAuditColumnContract[];

export const PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS = [
  {
    name: PRODUCT_STATUS_PRODUCT_AUDIT_TABLE,
    engine: 'innodb',
    tableCollation: 'utf8mb4_unicode_ci',
    columns: PRODUCT_AUDIT_COLUMNS,
    primaryKey: ['product_id'],
    createSql: `CREATE TABLE ${PRODUCT_STATUS_PRODUCT_AUDIT_TABLE} (
      product_id VARCHAR(255) NOT NULL,
      original_stock INT UNSIGNED NOT NULL,
      transaction_id VARCHAR(255) NULL,
      transaction_stock_anomaly TINYINT UNSIGNED NOT NULL,
      captured_at TIMESTAMP(6) NOT NULL,
      PRIMARY KEY (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
  {
    name: PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
    engine: 'innodb',
    tableCollation: 'utf8mb4_unicode_ci',
    columns: REQUEST_AUDIT_COLUMNS,
    primaryKey: ['transaction_id'],
    createSql: `CREATE TABLE ${PRODUCT_STATUS_REQUEST_AUDIT_TABLE} (
      transaction_id VARCHAR(255) NOT NULL,
      request_id_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_id_character_length SMALLINT UNSIGNED NOT NULL,
      violates_current_length_limit TINYINT UNSIGNED NOT NULL,
      contains_noncanonical_character TINYINT UNSIGNED NOT NULL,
      captured_at TIMESTAMP(6) NOT NULL,
      PRIMARY KEY (transaction_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
] as const satisfies readonly ProductStatusAuditTableContract[];

export const PRODUCT_STATUS_AUDIT_REQUIRED_COLUMNS = {
  [PRODUCT_STATUS_PRODUCT_AUDIT_TABLE]: PRODUCT_AUDIT_COLUMNS.map(
    ({ column }) => column,
  ),
  [PRODUCT_STATUS_REQUEST_AUDIT_TABLE]: REQUEST_AUDIT_COLUMNS.map(
    ({ column }) => column,
  ),
} satisfies Record<
  (typeof PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS)[number]['name'],
  readonly string[]
>;
