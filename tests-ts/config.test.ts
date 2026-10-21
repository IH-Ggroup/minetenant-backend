import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

describe('USERNAME_AUTH_ENABLED configuration', () => {
  it.each(['local', 'test', 'testing'])(
    'defaults to false when omitted in %s',
    (appEnv) => {
      expect(readConfig({ APP_ENV: appEnv }).usernameAuthEnabled).toBe(false);
    },
  );

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('accepts the exact value %s', (value, expected) => {
    expect(
      readConfig({
        APP_ENV: 'production',
        USERNAME_AUTH_ENABLED: value,
      }).usernameAuthEnabled,
    ).toBe(expected);
  });

  it('requires an explicit value in production', () => {
    expect(() => readConfig({ APP_ENV: 'production' })).toThrow(
      'USERNAME_AUTH_ENABLED must be explicitly set.',
    );
  });

  it.each(['', 'TRUE', 'False', ' true ', '0', '1'])(
    'rejects the non-canonical value %j in every environment',
    (value) => {
      for (const appEnv of ['local', 'testing', 'production']) {
        expect(() =>
          readConfig({ APP_ENV: appEnv, USERNAME_AUTH_ENABLED: value }),
        ).toThrow('USERNAME_AUTH_ENABLED must be exactly true or false.');
      }
    },
  );
});
