import { describe, expect, it } from 'vitest';
import { PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS } from '../src/db/product-status-audit-contract.js';
import { PRODUCT_STATUS_TRIGGER_CONTRACTS } from '../src/db/product-status-trigger-contract.js';
import {
  DatabaseReadinessError,
  assertDatabaseServerSupported,
  evaluateDatabaseMetadata,
  readinessActions,
  readinessProblems,
  INITIAL_SCHEMA_REQUIREMENTS,
  REQUIRED_SCHEMA,
  supportsMySqlVersion,
} from '../src/readiness.js';

const auditColumnContracts = new Map(
  PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS.flatMap(({ columns }) =>
    columns.map((column) => [`${column.table}.${column.column}`, column]),
  ),
);
const columns = Object.entries(REQUIRED_SCHEMA).flatMap(
  ([tableName, requiredColumns]) =>
    requiredColumns.map((columnName) => {
      const contract = auditColumnContracts.get(`${tableName}.${columnName}`);
      return contract
        ? {
            tableName,
            columnName,
            columnType: contract.columnType,
            isNullable: contract.nullable,
            characterSetName: contract.characterSet,
            collationName: contract.collation,
            columnDefault: contract.defaultValue,
            extra: '',
            generationExpression: '',
          }
        : { tableName, columnName };
    }),
);
const indexes = [
  {
    tableName: 'schema_migrations',
    indexName: 'PRIMARY',
    nonUnique: 0,
    sequence: 1,
    columnName: 'version',
  },
  {
    tableName: 'users',
    indexName: 'email_unique',
    nonUnique: 0,
    sequence: 1,
    columnName: 'email',
  },
  {
    tableName: 'users',
    indexName: 'users_username_unique',
    nonUnique: 0,
    sequence: 1,
    columnName: 'username',
  },
  {
    tableName: 'stores',
    indexName: 'owner_unique',
    nonUnique: 0,
    sequence: 1,
    columnName: 'user_id',
  },
  {
    tableName: 'purchase_transactions',
    indexName: 'request_unique',
    nonUnique: 0,
    sequence: 1,
    columnName: 'request_id',
  },
  {
    tableName: 'products',
    indexName: 'listing_request_unique',
    nonUnique: 0,
    sequence: 1,
    columnName: 'user_id',
  },
  {
    tableName: 'products',
    indexName: 'listing_request_unique',
    nonUnique: 0,
    sequence: 2,
    columnName: 'listing_request_id',
  },
  {
    tableName: 'products',
    indexName: 'product_seller_unique',
    nonUnique: 0,
    sequence: 1,
    columnName: 'product_id',
  },
  {
    tableName: 'products',
    indexName: 'product_seller_unique',
    nonUnique: 0,
    sequence: 2,
    columnName: 'user_id',
  },
  {
    tableName: 'purchase_transactions',
    indexName: 'product_unique',
    nonUnique: 0,
    sequence: 1,
    columnName: 'product_id',
  },
  ...PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS.flatMap(({ name, primaryKey }) =>
    primaryKey.map((columnName, index) => ({
      tableName: name,
      indexName: 'PRIMARY',
      nonUnique: 0,
      sequence: index + 1,
      columnName,
      isVisible: 'YES',
      expression: null,
      subPart: null,
      collation: 'A',
      indexType: 'BTREE',
    })),
  ),
];
const triggers = PRODUCT_STATUS_TRIGGER_CONTRACTS.map((trigger) => ({
  triggerName: trigger.name,
  eventObjectTable: trigger.table,
  eventManipulation: trigger.event,
  actionTiming: trigger.timing,
  actionOrientation: trigger.orientation,
  actionStatement: trigger.statement,
}));
const auditTableMetadata = PRODUCT_STATUS_AUDIT_TABLE_CONTRACTS.map(
  (table) => ({
    tableName: table.name,
    engine: table.engine,
    tableCollation: table.tableCollation,
  }),
);

describe('database readiness', () => {
  it('accepts supported MySQL releases but not MariaDB or older versions', () => {
    expect(supportsMySqlVersion('8.0.16', 'MySQL Community Server')).toBe(
      false,
    );
    expect(supportsMySqlVersion('8.0.17', 'MySQL Community Server')).toBe(true);
    expect(supportsMySqlVersion('8.0.45', 'MySQL Community Server')).toBe(true);
    expect(supportsMySqlVersion('8.4.11', 'MySQL Community Server')).toBe(true);
    expect(supportsMySqlVersion('9.5.0', 'MySQL Community Server')).toBe(true);
    expect(supportsMySqlVersion('5.7.44', 'MySQL Community Server')).toBe(
      false,
    );
    expect(supportsMySqlVersion('11.4.8-MariaDB', 'MariaDB Server')).toBe(
      false,
    );
  });

  it('directs unsupported servers to the actual minimum MySQL release', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.0.16',
        versionComment: 'MySQL Community Server',
      },
      columns,
      indexes,
      undefined,
      triggers,
      auditTableMetadata,
      [],
    );

    expect(readinessActions(readiness)).toContain(
      'MySQL 8.0.17以上へ切り替えてください。',
    );
    expect(new DatabaseReadinessError(readiness).code).toBe(
      'MINETENANT_DATABASE_UNSUPPORTED',
    );
  });

  it('checks server compatibility without requiring application tables', async () => {
    const db = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('SELECT DATABASE()')) {
          return [
            {
              database: 'minetenant',
              version: '8.4.11',
              versionComment: 'MySQL Community Server',
            },
          ] as T[];
        }
        return [];
      },
    };

    await expect(
      assertDatabaseServerSupported(db, 'minetenant'),
    ).resolves.toMatchObject({
      versionSupported: true,
      missingTables: [],
    });
  });

  it('accepts the complete Hono schema', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      columns,
      indexes,
      undefined,
      triggers,
      auditTableMetadata,
      [],
    );
    expect(readinessProblems(readiness)).toEqual([]);
  });

  it('requires the username auth columns and semantic uniqueness', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      columns.filter(
        ({ tableName, columnName }) =>
          tableName !== 'users' ||
          !['username', 'display_name', 'password_hash'].includes(columnName),
      ),
      indexes.filter(({ indexName }) => indexName !== 'users_username_unique'),
      undefined,
      triggers,
      auditTableMetadata,
      [],
    );

    expect(readiness.missingColumns).toEqual([
      'users.username',
      'users.display_name',
      'users.password_hash',
    ]);
    expect(readiness.missingUniqueKeys).toEqual(['users.username']);
    expect(new DatabaseReadinessError(readiness).code).toBe(
      'MINETENANT_SCHEMA_MISMATCH',
    );
  });

  it('reports missing tables, columns and unique constraints', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      columns.filter(
        ({ tableName, columnName }) =>
          tableName !== 'hono_sessions' &&
          !(
            tableName === 'products' &&
            [
              'status',
              'listing_request_id',
              'listing_request_fingerprint',
              'deleted_at',
            ].includes(columnName)
          ),
      ),
      indexes.filter(
        ({ indexName }) =>
          ![
            'owner_unique',
            'listing_request_unique',
            'product_seller_unique',
            'product_unique',
          ].includes(indexName),
      ),
      undefined,
      triggers,
      auditTableMetadata,
      [],
    );
    expect(readiness.missingTables).toEqual(['hono_sessions']);
    expect(readiness.missingColumns).toEqual([
      'products.status',
      'products.listing_request_id',
      'products.listing_request_fingerprint',
      'products.deleted_at',
    ]);
    expect(readiness.missingUniqueKeys).toEqual([
      'stores.user_id',
      'products.(user_id,listing_request_id)',
      'products.(product_id,user_id)',
      'purchase_transactions.product_id',
    ]);
    expect(readinessProblems(readiness).join('\n')).toContain(
      '未作成のテーブル',
    );
    expect(readinessActions(readiness)).toEqual([
      'DBをバックアップし、schema_migrations の履歴と実際のテーブルを確認してください。',
      'DBをバックアップし、schema_migrations の履歴と不足または定義不一致の監査table・列・一意制約・triggerを確認してください。',
    ]);
    expect(new DatabaseReadinessError(readiness).code).toBe(
      'MINETENANT_SCHEMA_MISMATCH',
    );
  });

  it('requires both persistent product-status migration audit tables', () => {
    const auditTableNames = new Set([
      'product_status_migration_product_audit',
      'product_status_migration_request_audit',
    ]);
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      columns.filter(({ tableName }) => !auditTableNames.has(tableName)),
      indexes,
      undefined,
      triggers,
      auditTableMetadata.filter(
        ({ tableName }) => !auditTableNames.has(tableName),
      ),
      [],
    );

    expect(readiness.missingTables).toEqual([...auditTableNames]);
    expect(new DatabaseReadinessError(readiness).code).toBe(
      'MINETENANT_SCHEMA_MISMATCH',
    );
  });

  it('requires every persistent product-status migration audit column', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      columns.filter(
        ({ tableName, columnName }) =>
          !(
            tableName === 'product_status_migration_request_audit' &&
            columnName === 'request_id_sha256'
          ),
      ),
      indexes,
      undefined,
      triggers,
      auditTableMetadata,
      [],
    );

    expect(readiness.missingColumns).toContain(
      'product_status_migration_request_audit.request_id_sha256',
    );
    expect(new DatabaseReadinessError(readiness).code).toBe(
      'MINETENANT_SCHEMA_MISMATCH',
    );
  });

  it('requires semantic uniqueness for persistent migration audit identities', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      columns,
      indexes.filter(
        ({ tableName }) =>
          tableName !== 'product_status_migration_product_audit' &&
          tableName !== 'product_status_migration_request_audit',
      ),
      undefined,
      triggers,
      auditTableMetadata,
      [],
    );

    expect(readiness.missingUniqueKeys).toEqual([
      'product_status_migration_product_audit.product_id',
      'product_status_migration_request_audit.transaction_id',
    ]);
    expect(new DatabaseReadinessError(readiness).code).toBe(
      'MINETENANT_SCHEMA_MISMATCH',
    );
  });

  it.each([
    [
      'storage engine',
      () => ({
        columns,
        indexes,
        tables: auditTableMetadata.map((table) =>
          table.tableName === 'product_status_migration_product_audit'
            ? { ...table, engine: 'MyISAM' }
            : table,
        ),
        constraints: [],
        triggers,
      }),
    ],
    [
      'column definition',
      () => ({
        columns: columns.map((column) =>
          column.tableName === 'product_status_migration_product_audit' &&
          column.columnName === 'original_stock'
            ? { ...column, columnType: 'bigint unsigned' }
            : column,
        ),
        indexes,
        tables: auditTableMetadata,
        constraints: [],
        triggers,
      }),
    ],
    [
      'substitute unique index',
      () => ({
        columns,
        indexes: indexes.map((index) =>
          index.tableName === 'product_status_migration_product_audit'
            ? { ...index, indexName: 'product_id_unique' }
            : index,
        ),
        tables: auditTableMetadata,
        constraints: [],
        triggers,
      }),
    ],
    [
      'extra index',
      () => ({
        columns,
        indexes: [
          ...indexes,
          {
            tableName: 'product_status_migration_product_audit',
            indexName: 'unexpected_transaction_index',
            nonUnique: 1,
            sequence: 1,
            columnName: 'transaction_id',
            isVisible: 'YES',
            expression: null,
            subPart: null,
            collation: 'A',
            indexType: 'BTREE',
          },
        ],
        tables: auditTableMetadata,
        constraints: [],
        triggers,
      }),
    ],
    [
      'foreign key',
      () => ({
        columns,
        indexes,
        tables: auditTableMetadata,
        constraints: [
          {
            tableName: 'product_status_migration_product_audit',
            constraintName: 'unexpected_foreign',
            constraintType: 'FOREIGN KEY',
          },
        ],
        triggers,
      }),
    ],
    [
      'check constraint',
      () => ({
        columns,
        indexes,
        tables: auditTableMetadata,
        constraints: [
          {
            tableName: 'product_status_migration_product_audit',
            constraintName: 'unexpected_check',
            constraintType: 'CHECK',
          },
        ],
        triggers,
      }),
    ],
    [
      'trigger',
      () => ({
        columns,
        indexes,
        tables: auditTableMetadata,
        constraints: [],
        triggers: [
          ...triggers,
          {
            triggerName: 'unexpected_audit_trigger',
            eventObjectTable: 'product_status_migration_product_audit',
            eventManipulation: 'DELETE',
            actionTiming: 'BEFORE',
            actionOrientation: 'ROW',
            actionStatement: 'BEGIN SET @audit_deleted = 1; END',
          },
        ],
      }),
    ],
  ] as const)(
    'rejects persistent audit table %s drift',
    (name, metadataFactory) => {
      const metadata = metadataFactory();
      const readiness = evaluateDatabaseMetadata(
        'minetenant',
        {
          database: 'minetenant',
          version: '8.4.11',
          versionComment: 'MySQL Community Server',
        },
        [...metadata.columns],
        [...metadata.indexes],
        undefined,
        [...metadata.triggers],
        [...metadata.tables],
        [...metadata.constraints],
      );

      expect(readiness.invalidTables).toEqual([
        'product_status_migration_product_audit',
      ]);
      if (name === 'substitute unique index') {
        expect(readiness.missingUniqueKeys).not.toContain(
          'product_status_migration_product_audit.product_id',
        );
      }
      expect(readinessProblems(readiness).join('\n')).toContain(
        '定義不一致のテーブル',
      );
      expect(new DatabaseReadinessError(readiness).code).toBe(
        'MINETENANT_SCHEMA_MISMATCH',
      );
    },
  );

  it('reports missing and modified product compatibility triggers', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      columns,
      indexes,
      undefined,
      [
        { ...triggers[0]!, actionStatement: 'BEGIN SET NEW.stock = 0; END' },
        triggers[1]!,
      ],
      auditTableMetadata,
      [],
    );

    expect(readiness.invalidTriggers).toEqual([
      'products_status_compatibility_before_insert',
      'products_listing_tombstone_before_delete',
    ]);
    expect(readinessProblems(readiness).join('\n')).toContain(
      '不足または定義不一致のtrigger',
    );
    expect(new DatabaseReadinessError(readiness).code).toBe(
      'MINETENANT_SCHEMA_MISMATCH',
    );
  });

  it('preserves quoted literal case and spaces when comparing trigger definitions', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      columns,
      indexes,
      undefined,
      [
        {
          ...triggers[0]!,
          actionStatement: triggers[0]!.actionStatement.replace(
            "'available'",
            "'AVAILABLE'",
          ),
        },
        {
          ...triggers[1]!,
          actionStatement: triggers[1]!.actionStatement.replace(
            "'available'",
            "'avail able'",
          ),
        },
        triggers[2]!,
      ],
      auditTableMetadata,
      [],
    );

    expect(readiness.invalidTriggers).toEqual([
      'products_status_compatibility_before_insert',
      'products_status_compatibility_before_update',
    ]);
  });

  it('rejects unexpected product triggers but ignores triggers on unrelated tables', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      columns,
      indexes,
      undefined,
      [
        ...triggers,
        {
          triggerName: 'unexpected_products_trigger',
          eventObjectTable: 'products',
          eventManipulation: 'UPDATE',
          actionTiming: 'AFTER',
          actionOrientation: 'ROW',
          actionStatement: 'BEGIN SET @product_changed = 1; END',
        },
        {
          triggerName: 'unrelated_users_trigger',
          eventObjectTable: 'users',
          eventManipulation: 'UPDATE',
          actionTiming: 'AFTER',
          actionOrientation: 'ROW',
          actionStatement: 'BEGIN SET @user_changed = 1; END',
        },
      ],
      auditTableMetadata,
      [],
    );

    expect(readiness.invalidTriggers).toEqual(['unexpected_products_trigger']);
  });

  it('keeps the 0000 migration requirements on the historical column names', () => {
    expect(INITIAL_SCHEMA_REQUIREMENTS.tables.users).toContain('id');
    expect(INITIAL_SCHEMA_REQUIREMENTS.tables.users).not.toContain('user_id');
    expect(INITIAL_SCHEMA_REQUIREMENTS.tables.stores).toContain('owner_id');
    expect(INITIAL_SCHEMA_REQUIREMENTS.tables.products).toContain('seller_id');
    expect(INITIAL_SCHEMA_REQUIREMENTS.tables.purchase_transactions).toEqual(
      expect.arrayContaining(['id', 'buyer_id', 'seller_id']),
    );
    expect(INITIAL_SCHEMA_REQUIREMENTS.tables.hono_sessions).toContain('id');
  });

  it('classifies an empty database as repairable by setup', () => {
    const readiness = evaluateDatabaseMetadata(
      'minetenant',
      {
        database: 'minetenant',
        version: '8.4.11',
        versionComment: 'MySQL Community Server',
      },
      [],
      [],
    );
    expect(readiness.missingTables).toHaveLength(
      Object.keys(REQUIRED_SCHEMA).length,
    );
    expect(readiness.missingUniqueKeys).toEqual([]);
    expect(readinessActions(readiness)).toEqual([
      'DBをバックアップし、schema_migrations の履歴と実際のテーブルを確認してください。',
    ]);
    expect(new DatabaseReadinessError(readiness).code).toBe(
      'MINETENANT_SCHEMA_INCOMPLETE',
    );
  });
});
