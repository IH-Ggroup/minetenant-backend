import { describe, expect, it } from 'vitest';
import {
  normalizeUsername,
  parseLoginCredentials,
  parseRegisterCredentials,
} from '../src/domain/auth-credentials.js';
import { ValidationError } from '../src/domain/errors.js';

const validPassword = 'password';
const secretPassword = 'Secret-DO-NOT-LEAK';

function getValidationError(run: () => unknown): ValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error('Expected a ValidationError.');
}

function expectFieldError(field: string, run: () => unknown): ValidationError {
  const error = getValidationError(run);
  expect(error.status).toBe(422);
  expect(error.errors).toHaveProperty(field);
  return error;
}

describe('username credentials', () => {
  it('normalizes ECMAScript edge whitespace and ASCII uppercase', () => {
    expect(normalizeUsername('\uFEFF\u3000 Demo_User \n')).toBe('demo_user');
    expect(
      parseLoginCredentials({
        username: '\uFEFF\u3000 Demo_User \n',
        password: validPassword,
      }),
    ).toEqual({ username: 'demo_user', password: validPassword });
  });

  it.each(['ab', 'a'.repeat(33), 'demo-user', '利用者', 'demo user'])(
    'rejects an invalid username %j',
    (username) => {
      const error = expectFieldError('username', () =>
        parseLoginCredentials({ username, password: validPassword }),
      );
      expect(error.errors?.username).toEqual([
        'ユーザー名は小文字英数字と_で3〜32文字にしてください。',
      ]);
    },
  );

  it.each(['abc', 'a'.repeat(32)])(
    'accepts a username at a valid boundary %j',
    (username) => {
      expect(
        parseLoginCredentials({ username, password: validPassword }).username,
      ).toBe(username);
    },
  );

  it.each(['\u200Babc', 'abc\u0000'])(
    'does not remove a non-ECMAScript-trim character from %j',
    (username) => {
      expectFieldError('username', () =>
        parseLoginCredentials({ username, password: validPassword }),
      );
    },
  );

  it.each([null, 1, {}, []])('rejects a non-string username %#', (username) => {
    expectFieldError('username', () =>
      parseLoginCredentials({ username, password: validPassword }),
    );
  });

  it('reserves system usernames only for public registration', () => {
    for (const [username, normalized] of [
      ['demo', 'demo'],
      [' SELLER ', 'seller'],
    ] as const) {
      expectFieldError('username', () =>
        parseRegisterCredentials({ username, password: validPassword }),
      );
      expect(
        parseLoginCredentials({ username, password: validPassword }).username,
      ).toBe(normalized);
    }
  });
});

describe('registration display name', () => {
  it.each([
    [{}, 'demo_user'],
    [{ displayName: null }, 'demo_user'],
    [{ displayName: '' }, 'demo_user'],
    [{ displayName: '\u3000\n ' }, 'demo_user'],
    [{ displayName: '  山田 みどり\u3000' }, '山田 みどり'],
  ])('normalizes displayName %#', (extra, expected) => {
    expect(
      parseRegisterCredentials({
        username: ' Demo_User ',
        password: validPassword,
        ...extra,
      }).displayName,
    ).toBe(expected);
  });

  it.each(['名', '😀'.repeat(120)])(
    'accepts a display name at a valid code-point boundary',
    (displayName) => {
      expect(
        parseRegisterCredentials({
          username: 'new_user',
          displayName,
          password: validPassword,
        }).displayName,
      ).toBe(displayName);
    },
  );

  it('rejects more than 120 Unicode code points', () => {
    expectFieldError('displayName', () =>
      parseRegisterCredentials({
        username: 'new_user',
        displayName: '😀'.repeat(121),
        password: validPassword,
      }),
    );
  });

  it.each([1, {}, []])('rejects a non-string displayName %#', (displayName) => {
    expectFieldError('displayName', () =>
      parseRegisterCredentials({
        username: 'new_user',
        displayName,
        password: validPassword,
      }),
    );
  });
});

describe('password credentials', () => {
  it('checks the minimum in Unicode code points', () => {
    expectFieldError('password', () =>
      parseLoginCredentials({ username: 'new_user', password: '😀'.repeat(7) }),
    );
    expect(
      parseLoginCredentials({
        username: 'new_user',
        password: '😀'.repeat(8),
      }).password,
    ).toBe('😀'.repeat(8));
  });

  it('checks the bcrypt limit in UTF-8 bytes', () => {
    expect(
      parseLoginCredentials({
        username: 'new_user',
        password: 'a'.repeat(72),
      }).password,
    ).toBe('a'.repeat(72));
    expectFieldError('password', () =>
      parseLoginCredentials({
        username: 'new_user',
        password: 'a'.repeat(73),
      }),
    );
    expect(
      parseLoginCredentials({
        username: 'new_user',
        password: '😀'.repeat(18),
      }).password,
    ).toBe('😀'.repeat(18));
    expectFieldError('password', () =>
      parseLoginCredentials({
        username: 'new_user',
        password: '😀'.repeat(19),
      }),
    );
  });

  it('rejects NUL without exposing the password', () => {
    const password = 'sentinel\0password';
    const error = expectFieldError('password', () =>
      parseLoginCredentials({ username: 'new_user', password }),
    );
    expect(error.message).not.toContain('sentinel');
    expect(JSON.stringify(error.errors)).not.toContain('sentinel');
  });

  it('preserves leading and trailing password whitespace', () => {
    const password = ' password ';
    expect(
      parseLoginCredentials({ username: 'new_user', password }).password,
    ).toBe(password);
  });

  it.each([null, 1, {}, []])('rejects a non-string password %#', (password) => {
    expectFieldError('password', () =>
      parseLoginCredentials({ username: 'new_user', password }),
    );
  });
});

describe('password confirmation', () => {
  it('accepts omission and an exact raw match, then discards the confirmation', () => {
    expect(
      parseRegisterCredentials({
        username: 'new_user',
        password: validPassword,
      }),
    ).toEqual({
      username: 'new_user',
      displayName: 'new_user',
      password: validPassword,
    });

    const password = ' password ';
    expect(
      parseRegisterCredentials({
        username: 'new_user',
        password,
        passwordConfirmation: password,
      }),
    ).toEqual({ username: 'new_user', displayName: 'new_user', password });
  });

  it.each([` ${secretPassword} `, secretPassword.toLowerCase()])(
    'rejects a raw mismatch %j',
    (passwordConfirmation) => {
      const error = expectFieldError('passwordConfirmation', () =>
        parseRegisterCredentials({
          username: 'new_user',
          password: secretPassword,
          passwordConfirmation,
        }),
      );
      expect(error.message).not.toContain(secretPassword);
      expect(JSON.stringify(error.errors)).not.toContain(secretPassword);
    },
  );

  it.each([undefined, null, 1, {}, []])(
    'rejects a present non-string confirmation %#',
    (passwordConfirmation) => {
      expectFieldError('passwordConfirmation', () =>
        parseRegisterCredentials({
          username: 'new_user',
          password: validPassword,
          passwordConfirmation,
        }),
      );
    },
  );
});

describe('credential validation behavior', () => {
  it('reports both required fields for an empty input', () => {
    const error = getValidationError(() => parseLoginCredentials({}));
    expect(Object.keys(error.errors ?? {}).sort()).toEqual([
      'password',
      'username',
    ]);
  });

  it('aggregates camelCase field errors', () => {
    const error = getValidationError(() =>
      parseRegisterCredentials({
        username: null,
        displayName: 1,
        password: 'short',
        passwordConfirmation: 'different',
      }),
    );
    expect(Object.keys(error.errors ?? {}).sort()).toEqual([
      'displayName',
      'password',
      'passwordConfirmation',
      'username',
    ]);
  });

  it('does not mutate a frozen input object', () => {
    const input = Object.freeze({
      username: ' New_User ',
      displayName: ' Display Name ',
      password: ' password ',
      passwordConfirmation: ' password ',
    });
    expect(parseRegisterCredentials(input)).toEqual({
      username: 'new_user',
      displayName: 'Display Name',
      password: ' password ',
    });
    expect(input).toEqual({
      username: ' New_User ',
      displayName: ' Display Name ',
      password: ' password ',
      passwordConfirmation: ' password ',
    });
  });

  it('rejects present undefined values instead of treating them as omitted', () => {
    expectFieldError('displayName', () =>
      parseRegisterCredentials({
        username: 'new_user',
        displayName: undefined,
        password: validPassword,
      }),
    );
  });

  it('does not accept inherited values as request fields', () => {
    const input = Object.create({
      username: 'inherited_user',
      password: validPassword,
    }) as Record<string, unknown>;
    const error = getValidationError(() => parseLoginCredentials(input));
    expect(Object.keys(error.errors ?? {}).sort()).toEqual([
      'password',
      'username',
    ]);
  });
});
