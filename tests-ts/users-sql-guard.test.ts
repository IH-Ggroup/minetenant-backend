import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_STATUS_PRODUCT_AUDIT_TABLE,
  PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
} from '../src/db/product-status-audit-contract.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.mjs',
  '.mts',
  '.sql',
  '.ts',
]);
const sqlTriviaAtom = String.raw`(?:\s|\/\*[\s\S]*?\*\/|--[ \t][^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$))`;
const sqlGap = `${sqlTriviaAtom}+`;
const optionalSqlGap = `${sqlTriviaAtom}*`;
const sqlIdentifier = '(?:[a-z0-9_$]+|`[^`\\r\\n]+`)';
const usersTable = `(?:${sqlIdentifier}${optionalSqlGap}\\.${optionalSqlGap})?(?:users|\`users\`)(?![a-z0-9_$])`;
const dynamicTable = String.raw`\$\{\s*(?<tableExpression>[^}\r\n]+?)\s*\}`;
const guardedTable = `(?:${usersTable}|${dynamicTable})`;
const allowedDynamicStatements = new Map([
  [
    'src/db/migrations/0002-product-status.ts',
    new Set([
      'INSERT IGNORE:PRODUCT_STATUS_PRODUCT_AUDIT_TABLE',
      'INSERT IGNORE:PRODUCT_STATUS_REQUEST_AUDIT_TABLE',
    ]),
  ],
]);
const forbiddenStatements = [
  {
    name: 'INSERT IGNORE',
    pattern: new RegExp(
      String.raw`\bINSERT${sqlGap}(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY)${sqlGap})?IGNORE${sqlGap}(?:INTO${sqlGap})?${guardedTable}`,
      'giu',
    ),
  },
  {
    name: 'UPDATE IGNORE',
    pattern: new RegExp(
      String.raw`\bUPDATE${sqlGap}(?:LOW_PRIORITY${sqlGap})?IGNORE${sqlGap}${guardedTable}`,
      'giu',
    ),
  },
  {
    name: 'REPLACE',
    pattern: new RegExp(
      String.raw`\bREPLACE${sqlGap}(?:(?:LOW_PRIORITY|DELAYED)${sqlGap})?(?:INTO${sqlGap})?${guardedTable}`,
      'giu',
    ),
  },
] as const;

interface ForbiddenUsersStatement {
  name: (typeof forbiddenStatements)[number]['name'];
  index: number;
  target: string;
}

function findForbiddenUsersStatements(
  source: string,
): ForbiddenUsersStatement[] {
  const violations: ForbiddenUsersStatement[] = [];
  for (const { name, pattern } of forbiddenStatements) {
    for (const match of source.matchAll(pattern)) {
      const tableExpression = match.groups?.tableExpression?.trim();
      violations.push({
        name,
        index: match.index,
        target: tableExpression ?? 'users',
      });
    }
  }
  return violations;
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll('\\', '/');
}

function isAllowedDynamicStatementAtPath(
  repositoryPath: string,
  violation: ForbiddenUsersStatement,
): boolean {
  return (
    allowedDynamicStatements
      .get(normalizePathSeparators(repositoryPath))
      ?.has(`${violation.name}:${violation.target}`) ?? false
  );
}

function isAllowedDynamicStatement(
  file: string,
  violation: ForbiddenUsersStatement,
): boolean {
  return isAllowedDynamicStatementAtPath(
    relative(repositoryRoot, file),
    violation,
  );
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name)))
      files.push(path);
  }
  return files.sort();
}

describe('users SQL safety guard', () => {
  it('normalizes Windows path separators before allowlist lookup', () => {
    expect(
      isAllowedDynamicStatementAtPath(
        String.raw`src\db\migrations\0002-product-status.ts`,
        {
          name: 'INSERT IGNORE',
          index: 0,
          target: 'PRODUCT_STATUS_PRODUCT_AUDIT_TABLE',
        },
      ),
    ).toBe(true);
  });

  it.each([
    ['INSERT IGNORE INTO users (user_id) VALUES (?)', 'INSERT IGNORE'],
    [
      'insert high_priority ignore `tenant`.`users` VALUES (?)',
      'INSERT IGNORE',
    ],
    ['INSERT/**/IGNORE/**/INTO/**/users VALUES (?)', 'INSERT IGNORE'],
    ['UPDATE IGNORE `users` SET username = ?', 'UPDATE IGNORE'],
    [
      'update low_priority ignore tenant.users SET username = ?',
      'UPDATE IGNORE',
    ],
    [
      'UPDATE /* guarded */ IGNORE `123tenant`.users SET role = ?',
      'UPDATE IGNORE',
    ],
    ['REPLACE INTO users (user_id) VALUES (?)', 'REPLACE'],
    ['replace delayed `tenant`.`users` VALUES (?)', 'REPLACE'],
  ])('detects %j as %s', (sql, name) => {
    expect(findForbiddenUsersStatements(sql)).toEqual([
      { name, index: 0, target: 'users' },
    ]);
  });

  it('fails closed for a dynamic table target that is not explicitly safe', () => {
    expect(
      findForbiddenUsersStatements(
        'INSERT IGNORE INTO ${USERS_TABLE} (user_id) VALUES (?)',
      ),
    ).toEqual([{ name: 'INSERT IGNORE', index: 0, target: 'USERS_TABLE' }]);
  });

  it('targets users without rejecting the product-status audit inserts', async () => {
    expect([
      PRODUCT_STATUS_PRODUCT_AUDIT_TABLE,
      PRODUCT_STATUS_REQUEST_AUDIT_TABLE,
    ]).toEqual([
      'product_status_migration_product_audit',
      'product_status_migration_request_audit',
    ]);
    for (const sql of [
      'INSERT IGNORE INTO product_status_migration_product_audit VALUES (?)',
      'INSERT IGNORE INTO `users_archive` VALUES (?)',
      'UPDATE IGNORE app.users_history SET username = ?',
      'REPLACE INTO product_status_migration_request_audit VALUES (?)',
    ]) {
      expect(findForbiddenUsersStatements(sql)).toEqual([]);
    }

    const productStatusMigrationPath = join(
      repositoryRoot,
      'src/db/migrations/0002-product-status.ts',
    );
    const productStatusMigration = await readFile(
      productStatusMigrationPath,
      'utf8',
    );
    expect(productStatusMigration).toContain('INSERT IGNORE');
    expect(
      findForbiddenUsersStatements(productStatusMigration).filter(
        (violation) =>
          !isAllowedDynamicStatement(productStatusMigrationPath, violation),
      ),
    ).toEqual([]);
  });

  it('keeps executable source and scripts free of unsafe users statements', async () => {
    const files = (
      await Promise.all(
        ['src', 'scripts', 'database'].map((directory) =>
          sourceFiles(join(repositoryRoot, directory)),
        ),
      )
    ).flat();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const violation of findForbiddenUsersStatements(source)) {
        if (isAllowedDynamicStatement(file, violation)) continue;
        const line = source.slice(0, violation.index).split('\n').length;
        violations.push(
          `${relative(repositoryRoot, file)}:${line}: ${violation.name} target ${violation.target}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});
