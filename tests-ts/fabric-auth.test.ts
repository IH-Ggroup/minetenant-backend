import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../src/app.js';
import type { Database } from '../src/db.js';
import { isValidFabricServerToken } from '../src/fabric-auth.js';
import { start, type ServerDependencies } from '../src/server.js';
import {
  createClient,
  createTestApp,
  expectStatus,
  TEST_FABRIC_SERVER_TOKEN,
  type TestApp,
} from './helpers.js';

describe('Fabric Dedicated Server authentication', () => {
  let setup: TestApp;

  beforeAll(async () => {
    setup = await createTestApp();
  });
  beforeEach(async () => {
    await setup.reset();
  });
  afterAll(async () => {
    await setup?.close();
  });

  it('accepts only the configured printable ASCII length boundaries', () => {
    expect(isValidFabricServerToken('x'.repeat(64))).toBe(true);
    expect(isValidFabricServerToken('x'.repeat(256))).toBe(true);
    expect(isValidFabricServerToken('x'.repeat(63))).toBe(false);
    expect(isValidFabricServerToken('x'.repeat(257))).toBe(false);
    expect(isValidFabricServerToken(`${'x'.repeat(63)} `)).toBe(false);
    expect(isValidFabricServerToken(`${'x'.repeat(64)}\n`)).toBe(false);
    expect(isValidFabricServerToken('秘'.repeat(64))).toBe(false);
  });

  it.each([
    undefined,
    'Basic ZmFrZTpmYWtl',
    'Bearer',
    `Bearer ${'x'.repeat(64)}`,
    `Bearer ${TEST_FABRIC_SERVER_TOKEN} extra`,
  ])(
    'returns the same 401 without disclosing credentials for %j',
    async (authorization) => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      try {
        const response = await setup.app.request('/api/v1/minecraft/catalog', {
          headers:
            authorization === undefined ? {} : { Authorization: authorization },
        });
        await expectStatus(response, 401);
        expect(response.headers.get('WWW-Authenticate')).toBe(
          'Bearer realm="minetenant-fabric"',
        );
        expect(response.headers.getSetCookie()).toHaveLength(0);
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({
          message: 'Fabric server authentication failed.',
          code: 'FABRIC_AUTHENTICATION_FAILED',
        });
        expect(text).not.toContain(TEST_FABRIC_SERVER_TOKEN);
        expect(text).not.toContain('x'.repeat(64));
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it('authenticates the whole Minecraft prefix before routing', async () => {
    const authorization = {
      Authorization: `bearer ${TEST_FABRIC_SERVER_TOKEN}`,
    };
    await expectStatus(
      await setup.app.request('/api/v1/minecraft/catalog', {
        headers: authorization,
      }),
      200,
    );
    await expectStatus(
      await setup.app.request('/api/v1/minecraft/not-found'),
      401,
    );
    await expectStatus(
      await setup.app.request('/api/v1/minecraft/not-found', {
        headers: authorization,
      }),
      404,
    );
  });

  it('rejects authentication before any business database access', async () => {
    const query = vi.fn(() => {
      throw new Error('business query must not run');
    });
    const execute = vi.fn(() => {
      throw new Error('business mutation must not run');
    });
    const transaction = vi.fn(() => {
      throw new Error('business transaction must not run');
    });
    const app = createApp({
      db: { query, execute, transaction } as unknown as Database,
      config: setup.config,
    });

    await expectStatus(
      await app.request('/api/v1/minecraft/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: 'private-product' }),
      }),
      401,
    );
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['', 'short-token', 'x'.repeat(63), `${'x'.repeat(63)} `])(
    'fails closed with 503 when the injected credential is invalid',
    async (fabricServerToken) => {
      const response = await createApp({
        db: setup.db,
        config: { ...setup.config, fabricServerToken },
      }).request('/api/v1/minecraft/catalog', {
        headers: { Authorization: `Bearer ${fabricServerToken}` },
      });
      await expectStatus(response, 503);
      expect(await response.json()).toEqual({
        message: 'Fabric server authentication is unavailable.',
        code: 'FABRIC_AUTHENTICATION_UNAVAILABLE',
      });
    },
  );

  it.each([
    ['local debug', 'local', true, ''],
    ['production', 'production', false, 'private-invalid-token'],
  ])(
    'stops %s startup before database creation when the credential is invalid',
    async (_label, appEnv, debug, fabricServerToken) => {
      const createDatabase = vi.fn();
      const serve = vi.fn();
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;

      try {
        await start({
          readConfig: () => ({
            ...setup.config,
            appEnv,
            debug,
            fabricServerToken,
          }),
          createDatabase,
          serve: serve as unknown as ServerDependencies['serve'],
        });
        expect(createDatabase).not.toHaveBeenCalled();
        expect(serve).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        const output = consoleError.mock.calls.flat().join('\n');
        expect(output).toContain('MINETENANT_FABRIC_SERVER_TOKEN');
        expect(output).not.toContain(TEST_FABRIC_SERVER_TOKEN);
        if (fabricServerToken) expect(output).not.toContain(fabricServerToken);
      } finally {
        process.exitCode = previousExitCode;
        consoleError.mockRestore();
      }
    },
  );

  it('does not apply Fabric credentials to Web routes', async () => {
    const client = createClient(setup.app);
    await expectStatus(await client.request('/api/v1/products'), 200);
    await expectStatus(await client.request('/api/v1/auth/csrf-cookie'), 204);
  });
});
