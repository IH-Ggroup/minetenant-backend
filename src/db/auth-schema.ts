import type { MigrationExecutor, SqlExecutor } from '../db.js';

export const AUTH_USERNAME_MIGRATION_VERSION = '0003_username_auth';
export const AUTH_USERNAME_INDEX = 'users_username_unique';

export class AuthSchemaMigrationError extends Error {
  readonly code = 'MINETENANT_AUTH_SCHEMA_MIGRATION_UNSAFE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthSchemaMigrationError';
  }
}

interface CurrentDatabaseRow {
  databaseName: string | null;
}

interface ColumnRow {
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

interface TableCountRow {
  count: number | string;
}

interface GroupedIndex {
  name: string;
  unique: boolean;
  visible: boolean;
  plainAscendingBtree: boolean;
  columns: string[];
}

export interface AuthSchemaState {
  databaseName: string;
  columns: ReadonlyMap<string, ColumnRow>;
  indexes: readonly GroupedIndex[];
  expanded: boolean;
  legacyColumnsNullable: boolean;
  usernameIndexPresent: boolean;
}

interface ColumnDefinition {
  name: string;
  type: string;
  characterSet: string;
  collation: string;
}

const LEGACY_COLUMNS = [
  {
    name: 'name',
    type: 'varchar(255)',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    name: 'email',
    type: 'varchar(255)',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    name: 'password',
    type: 'varchar(255)',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    name: 'role_label',
    type: 'varchar(255)',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    name: 'avatar_initial',
    type: 'varchar(8)',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
] as const satisfies readonly ColumnDefinition[];

const NEW_COLUMNS = [
  {
    name: 'username',
    type: 'varchar(32)',
    characterSet: 'ascii',
    collation: 'ascii_bin',
  },
  {
    name: 'display_name',
    type: 'varchar(120)',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
  {
    name: 'password_hash',
    type: 'varchar(255)',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
] as const satisfies readonly ColumnDefinition[];

function unsafe(message: string, cause?: unknown): never {
  throw new AuthSchemaMigrationError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function groupIndexes(rows: readonly IndexRow[]): GroupedIndex[] {
  const grouped = new Map<string, GroupedIndex>();
  for (const row of rows) {
    const current = grouped.get(row.indexName) ?? {
      name: row.indexName,
      unique: row.nonUnique === 0,
      visible: row.isVisible === 'YES',
      plainAscendingBtree: true,
      columns: [],
    };
    if (
      row.expression !== null ||
      row.columnName === null ||
      row.subPart !== null ||
      row.collation !== 'A' ||
      row.indexType.toUpperCase() !== 'BTREE' ||
      row.sequence !== current.columns.length + 1
    ) {
      current.plainAscendingBtree = false;
    }
    if (row.columnName !== null) current.columns.push(row.columnName);
    grouped.set(row.indexName, current);
  }
  return [...grouped.values()];
}

function sameColumns(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((column, index) => column === expected[index])
  );
}

function assertColumn(
  row: ColumnRow | undefined,
  definition: ColumnDefinition,
  allowedNullability: readonly ('YES' | 'NO')[],
): void {
  if (!row) unsafe(`Required users.${definition.name} column is missing.`);
  if (
    row.columnType.toLowerCase() !== definition.type ||
    !allowedNullability.includes(row.isNullable) ||
    row.characterSetName?.toLowerCase() !== definition.characterSet ||
    row.collationName?.toLowerCase() !== definition.collation ||
    row.columnDefault !== null ||
    row.extra.trim() !== '' ||
    (row.generationExpression?.trim().length ?? 0) > 0
  ) {
    unsafe(`users.${definition.name} has an unexpected definition.`);
  }
}

function assertPreservedIndex(
  indexes: readonly GroupedIndex[],
  allowedNames: readonly string[],
  columns: readonly string[],
  unique: boolean,
): void {
  const matching = indexes.filter(
    (index) =>
      allowedNames.includes(index.name) &&
      index.unique === unique &&
      index.visible &&
      index.plainAscendingBtree &&
      sameColumns(index.columns, columns),
  );
  if (matching.length !== 1) {
    unsafe(`Required users index for ${columns.join(', ')} is missing.`);
  }
  const unexpected = indexes.find(
    (index) =>
      sameColumns(index.columns, columns) &&
      index.unique === unique &&
      !allowedNames.includes(index.name),
  );
  if (unexpected) {
    unsafe(`Unexpected equivalent users index: ${unexpected.name}.`);
  }
}

function inspectUsernameIndex(indexes: readonly GroupedIndex[]): boolean {
  const named = indexes.find(({ name }) => name === AUTH_USERNAME_INDEX);
  if (
    named &&
    (!named.unique ||
      !named.visible ||
      !named.plainAscendingBtree ||
      !sameColumns(named.columns, ['username']))
  ) {
    unsafe(`Index name collision: users.${AUTH_USERNAME_INDEX}.`);
  }
  const equivalents = indexes.filter(
    (index) =>
      index.unique &&
      index.visible &&
      index.plainAscendingBtree &&
      sameColumns(index.columns, ['username']),
  );
  if (equivalents.some(({ name }) => name !== AUTH_USERNAME_INDEX)) {
    unsafe('An unexpected equivalent username UNIQUE index already exists.');
  }
  return named !== undefined;
}

export async function inspectAuthSchema(
  db: SqlExecutor,
): Promise<AuthSchemaState> {
  const [current] = await db.query<CurrentDatabaseRow>(
    'SELECT DATABASE() AS databaseName',
  );
  if (!current?.databaseName) unsafe('A database must be selected.');

  const rows = await db.query<ColumnRow>(
    `SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
            IS_NULLABLE AS isNullable,
            CHARACTER_SET_NAME AS characterSetName,
            COLLATION_NAME AS collationName,
            COLUMN_DEFAULT AS columnDefault, EXTRA AS extra,
            GENERATION_EXPRESSION AS generationExpression
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'users'`,
    [current.databaseName],
  );
  const columns = new Map(rows.map((row) => [row.columnName, row]));

  for (const definition of LEGACY_COLUMNS) {
    assertColumn(columns.get(definition.name), definition, ['YES', 'NO']);
  }
  const userId = columns.get('user_id');
  if (
    !userId ||
    userId.columnType.toLowerCase() !== 'varchar(255)' ||
    userId.isNullable !== 'NO' ||
    userId.characterSetName?.toLowerCase() !== 'utf8mb4' ||
    userId.collationName?.toLowerCase() !== 'utf8mb4_unicode_ci'
  ) {
    unsafe('users.user_id does not match the #114 contract.');
  }

  for (const definition of NEW_COLUMNS) {
    const row = columns.get(definition.name);
    if (row) assertColumn(row, definition, ['YES']);
  }

  const indexRows = await db.query<IndexRow>(
    `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequence, COLUMN_NAME AS columnName,
            IS_VISIBLE AS isVisible, EXPRESSION AS expression,
            SUB_PART AS subPart, COLLATION AS collation,
            INDEX_TYPE AS indexType
       FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = 'users'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [current.databaseName],
  );
  const indexes = groupIndexes(indexRows);
  assertPreservedIndex(
    indexes,
    ['email', 'users_email_unique'],
    ['email'],
    true,
  );
  assertPreservedIndex(indexes, ['users_role_index'], ['role'], false);
  const usernameIndexPresent = inspectUsernameIndex(indexes);
  const newColumnCount = NEW_COLUMNS.filter(({ name }) =>
    columns.has(name),
  ).length;
  if (usernameIndexPresent && newColumnCount !== NEW_COLUMNS.length) {
    unsafe('The username index exists before all auth columns are present.');
  }

  return {
    databaseName: current.databaseName,
    columns,
    indexes,
    expanded: newColumnCount === NEW_COLUMNS.length,
    legacyColumnsNullable: LEGACY_COLUMNS.every(
      ({ name }) => columns.get(name)?.isNullable === 'YES',
    ),
    usernameIndexPresent,
  };
}

export async function expandAuthSchema(db: MigrationExecutor): Promise<void> {
  const state = await inspectAuthSchema(db);
  const clauses: string[] = [];
  if (!state.columns.has('username')) {
    clauses.push(
      'ADD COLUMN username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL AFTER user_id',
    );
  }
  if (!state.columns.has('display_name')) {
    clauses.push(
      'ADD COLUMN display_name VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL AFTER username',
    );
  }
  if (!state.columns.has('password_hash')) {
    clauses.push(
      'ADD COLUMN password_hash VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL AFTER display_name',
    );
  }
  for (const definition of LEGACY_COLUMNS) {
    if (state.columns.get(definition.name)?.isNullable === 'NO') {
      clauses.push(
        `MODIFY COLUMN \`${definition.name}\` ${definition.type.toUpperCase()} CHARACTER SET ${definition.characterSet} COLLATE ${definition.collation} NULL DEFAULT NULL`,
      );
    }
  }
  if (clauses.length > 0) {
    await db.execute(`ALTER TABLE users\n  ${clauses.join(',\n  ')}`);
  }

  const expanded = await inspectAuthSchema(db);
  if (!expanded.expanded || !expanded.legacyColumnsNullable) {
    unsafe('The users auth expand step did not reach the required schema.');
  }
}

export async function ensureUsernameUniqueIndex(
  db: MigrationExecutor,
): Promise<void> {
  const state = await inspectAuthSchema(db);
  if (!state.expanded || !state.legacyColumnsNullable) {
    unsafe('The username index cannot be added before auth schema expansion.');
  }
  if (!state.usernameIndexPresent) {
    await db.execute(
      `ALTER TABLE users ADD UNIQUE INDEX \`${AUTH_USERNAME_INDEX}\` (username)`,
    );
  }
  if (!(await inspectAuthSchema(db)).usernameIndexPresent) {
    unsafe('The username UNIQUE index was not created.');
  }
}

export async function assertExpandedAuthSchema(
  db: SqlExecutor,
): Promise<AuthSchemaState> {
  const state = await inspectAuthSchema(db);
  if (
    !state.expanded ||
    !state.legacyColumnsNullable ||
    !state.usernameIndexPresent
  ) {
    unsafe('The #98 users auth schema is incomplete.');
  }
  return state;
}

export async function assertAuthBackfillCommandReady(
  db: SqlExecutor,
): Promise<AuthSchemaState> {
  const state = await assertExpandedAuthSchema(db);
  const [historyTable] = await db.query<TableCountRow>(
    `SELECT COUNT(*) AS count FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'schema_migrations'`,
    [state.databaseName],
  );
  if (Number(historyTable?.count) !== 1) {
    unsafe('schema_migrations is missing. Apply migrations first.');
  }
  const [recorded] = await db.query<TableCountRow>(
    `SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?`,
    [AUTH_USERNAME_MIGRATION_VERSION],
  );
  if (Number(recorded?.count) !== 1) {
    unsafe('The #98 migration is not recorded. Apply migrations first.');
  }
  return state;
}
