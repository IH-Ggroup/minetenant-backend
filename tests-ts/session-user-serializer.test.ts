import { describe, expect, it } from 'vitest';
import {
  serializeSessionUser,
  serializeUser,
  SessionUserSerializationError,
} from '../src/domain/serializers.js';
import type { SessionUserRow, UserRow } from '../src/domain/types.js';

const passwordHash = '$2b$12$never-return-this-password-hash';

function sessionRow(overrides: Partial<SessionUserRow> = {}): SessionUserRow {
  return {
    user_id: 'internal-user-id',
    username: 'demo_user',
    display_name: 'デモ利用者',
    password_hash: passwordHash,
    role: 'buyer',
    store_id: null,
    ...overrides,
  };
}

function expectInvalid(row: SessionUserRow): void {
  try {
    serializeSessionUser(row);
    throw new Error('Expected session user serialization to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(SessionUserSerializationError);
    expect(error).toMatchObject({
      code: 'MINETENANT_AUTH_SESSION_USER_INVALID',
    });
    const values = row as unknown as Record<string, unknown>;
    for (const value of [
      values.user_id,
      values.username,
      values.display_name,
      values.password_hash,
      values.name,
      values.email,
      values.password,
      values.session_id,
      values.csrf_token,
    ]) {
      if (typeof value === 'string' && value.length > 0)
        expect((error as Error).message).not.toContain(value);
    }
  }
}

describe('session user serializer', () => {
  it.each([
    [
      'buyer without a store',
      sessionRow(),
      {
        id: 'internal-user-id',
        username: 'demo_user',
        displayName: 'デモ利用者',
        role: 'buyer',
        roleLabel: '購入者',
        avatarInitial: 'デ',
        storeId: null,
      },
    ],
    [
      'seller with a store',
      sessionRow({
        user_id: 'seller-id',
        username: 'seller_01',
        display_name: 'Seller 01',
        role: 'seller',
        store_id: 'store-id',
      }),
      {
        id: 'seller-id',
        username: 'seller_01',
        displayName: 'Seller 01',
        role: 'seller',
        roleLabel: '出品者',
        avatarInitial: 'S',
        storeId: 'store-id',
      },
    ],
  ])('serializes a %s to the exact seven-field DTO', (_case, row, expected) => {
    const serialized = serializeSessionUser(row);

    expect(serialized).toEqual(expected);
    expect(Object.keys(serialized).sort()).toEqual(
      [
        'avatarInitial',
        'displayName',
        'id',
        'role',
        'roleLabel',
        'storeId',
        'username',
      ].sort(),
    );
  });

  it.each([
    ['buyer', null, '購入者'],
    ['buyer', 'buyer-store', '購入者'],
    ['seller', null, '出品者'],
    ['seller', 'seller-store', '出品者'],
  ] as const)('supports role %s with store %s', (role, storeId, roleLabel) => {
    expect(
      serializeSessionUser(sessionRow({ role, store_id: storeId })),
    ).toMatchObject({ role, roleLabel, storeId });
  });

  it.each([
    ['日本語の表示名', '日本語の表示名', '日'],
    ['ASCII Display Name', 'ASCII Display Name', 'A'],
    ['long display name', '長'.repeat(120), '長'],
    ['emoji ZWJ sequence', '👩🏽‍💻 開発者', '👩🏽‍💻'],
    ['combining sequence', 'e\u0301clair', 'e\u0301'],
  ])('derives one grapheme for %s', (_case, displayName, avatarInitial) => {
    expect(
      serializeSessionUser(sessionRow({ display_name: displayName })),
    ).toMatchObject({ displayName, avatarInitial });
  });

  it.each([
    ['minimum length', 'abc'],
    ['maximum length', 'a'.repeat(32)],
    ['lowercase letters, numbers and underscore', 'user_123'],
    ['existing demo account', 'demo'],
    ['existing seller account', 'seller'],
  ])('accepts a canonical username for %s', (_case, username) => {
    expect(serializeSessionUser(sessionRow({ username }))).toMatchObject({
      username,
    });
  });

  it.each([
    ['leading whitespace', '  demo'],
    ['trailing whitespace', 'demo '],
    ['embedded whitespace', 'de mo'],
    ['whitespace only', '   '],
    ['an empty value', ''],
    ['fewer than 3 characters', 'ab'],
    ['more than 32 characters', 'a'.repeat(33)],
    ['uppercase ASCII', 'Demo'],
    ['a hyphen', 'demo-user'],
    ['a dot', 'demo.user'],
    ['non-ASCII characters', 'démo'],
    ['Unicode case-folding characters', '\u212Aelvin'],
    ['a zero-width space', 'demo\u200Buser'],
    ['a NUL character', 'demo\0user'],
  ])('fails closed for a username with %s', (_case, username) => {
    expectInvalid(sessionRow({ username }));
  });

  it('never returns legacy columns, secrets, session data or DB names', () => {
    const row = Object.assign(sessionRow(), {
      name: 'legacy-name',
      email: 'private@example.test',
      password: 'legacy-password-hash',
      role_label: 'untrusted-label',
      avatar_initial: 'X',
      session_id: 'private-session-id',
      csrf_token: 'private-csrf-token',
    });

    const serialized = serializeSessionUser(row);
    const encoded = JSON.stringify(serialized);

    for (const secret of [
      passwordHash,
      row.name,
      row.email,
      row.password,
      row.role_label,
      row.avatar_initial,
      row.session_id,
      row.csrf_token,
      'user_id',
      'store_id',
      'display_name',
      'password_hash',
      'passwordHash',
      'sessionId',
    ]) {
      expect(encoded).not.toContain(secret);
    }
  });

  it.each(['username', 'display_name', 'password_hash'] as const)(
    'fails closed when %s is null instead of using legacy columns',
    (field) => {
      const row = Object.assign(sessionRow({ [field]: null }), {
        name: 'legacy fallback name',
        password: 'legacy fallback password',
      });
      expectInvalid(row);
    },
  );

  it.each(['username', 'display_name', 'password_hash'] as const)(
    'fails closed when %s is missing or has a non-string value',
    (field) => {
      const missing = sessionRow();
      delete (missing as unknown as Record<string, unknown>)[field];
      expectInvalid(missing);

      expectInvalid(
        Object.assign(sessionRow(), { [field]: 123 }) as SessionUserRow,
      );
    },
  );

  it.each([
    ['an unknown role', { role: 'admin' }],
    ['a missing role', { role: undefined }],
    ['a null role', { role: null }],
    ['an empty display name', { display_name: '' }],
    ['a whitespace-only display name', { display_name: '   ' }],
    ['an untrimmed display name', { display_name: ' Display Name ' }],
    ['a missing user id', { user_id: undefined }],
    ['a null user id', { user_id: null }],
    ['a non-string user id', { user_id: 123 }],
    ['an empty user id', { user_id: '' }],
    ['a missing store alias', { store_id: undefined }],
    ['a non-string store id', { store_id: 123 }],
    ['an empty store id', { store_id: '' }],
  ])('fails closed for %s', (_case, overrides) => {
    expectInvalid(Object.assign(sessionRow(), overrides) as SessionUserRow);
  });

  it('fails with the same coded error when the row itself is absent', () => {
    expect(() =>
      serializeSessionUser(null as unknown as SessionUserRow),
    ).toThrowError(
      expect.objectContaining({
        code: 'MINETENANT_AUTH_SESSION_USER_INVALID',
      }),
    );
  });

  it('does not change the legacy user serializer contract', () => {
    const legacy: UserRow = {
      user_id: 'legacy-user-id',
      name: 'Legacy Name',
      email: 'legacy@example.test',
      password: 'legacy-password-hash',
      role: 'seller',
      role_label: '出品者デモ',
      avatar_initial: 'L',
      store_id: 'legacy-store-id',
    };

    expect(serializeUser(legacy)).toEqual({
      id: 'legacy-user-id',
      name: 'Legacy Name',
      role: 'seller',
      roleLabel: '出品者デモ',
      avatarInitial: 'L',
      storeId: 'legacy-store-id',
    });
  });
});
