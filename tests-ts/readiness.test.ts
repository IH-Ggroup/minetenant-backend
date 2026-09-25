import { describe, expect, it } from 'vitest';
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

const columns = Object.entries(REQUIRED_SCHEMA).flatMap(
  ([tableName, requiredColumns]) =>
    requiredColumns.map((columnName) => ({ tableName, columnName })),
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
];

describe('database readiness', () => {
  it('accepts supported MySQL releases but not MariaDB or older versions', () => {
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
    );
    expect(readinessProblems(readiness)).toEqual([]);
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
          !(tableName === 'products' && columnName === 'stock'),
      ),
      indexes.filter(({ tableName }) => tableName !== 'stores'),
    );
    expect(readiness.missingTables).toEqual(['hono_sessions']);
    expect(readiness.missingColumns).toEqual(['products.stock']);
    expect(readiness.missingUniqueKeys).toEqual(['stores.user_id']);
    expect(readinessProblems(readiness).join('\n')).toContain(
      '未作成のテーブル',
    );
    expect(readinessActions(readiness)).toEqual([
      'DBをバックアップし、schema_migrations の履歴と実際のテーブルを確認してください。',
      'DBをバックアップし、schema_migrations の履歴と不足している列・一意制約を確認してください。',
    ]);
    expect(new DatabaseReadinessError(readiness).code).toBe(
      'MINETENANT_SCHEMA_MISMATCH',
    );
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
