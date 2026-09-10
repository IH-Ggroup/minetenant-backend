import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { AppEnv } from '../src/types.js';
import {
  createClient,
  createTestApp,
  expectStatus,
  type TestApp,
} from './helpers.js';

const originToken = 'test-only-origin-token-with-at-least-32-characters';

describe('public tunnel boundary, proxy trust, and browser security headers', () => {
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

  function publicApp(overrides: Partial<AppConfig> = {}) {
    return createApp({
      db: setup.db,
      config: {
        ...setup.config,
        publicTunnel: true,
        originToken,
        debug: false,
        sessionSecure: true,
        ...overrides,
      },
    });
  }

  function bindings(remoteAddress: string): AppEnv['Bindings'] {
    return {
      incoming: { socket: { remoteAddress } },
    } as AppEnv['Bindings'];
  }

  it('rejects missing/wrong origin credentials with no diagnostic disclosure', async () => {
    const app = publicApp();
    for (const token of ['', 'wrong-token']) {
      const response = await app.request('/api/v1/auth/csrf-cookie', {
        headers: { 'X-MineTenant-Origin-Token': token },
      });
      await expectStatus(response, 403);
      expect(await response.json()).toEqual({ message: 'Forbidden.' });
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
  });

  it.each(['', 'short-token'])(
    'fails closed with an insufficient configured origin secret %j',
    async (configured) => {
      const response = await publicApp({
        originToken: configured,
      }).request('/api/v1/auth/csrf-cookie', {
        headers: { 'X-MineTenant-Origin-Token': configured },
      });
      await expectStatus(response, 503);
      expect(await response.json()).toEqual({
        message: 'Service unavailable.',
      });
    },
  );

  it('fails closed when debugging is enabled in public tunnel mode', async () => {
    const response = await publicApp({ debug: true }).request(
      '/api/v1/auth/csrf-cookie',
      {
        headers: { 'X-MineTenant-Origin-Token': originToken },
      },
    );
    await expectStatus(response, 503);
    expect(await response.json()).toEqual({
      message: 'Service unavailable.',
    });
  });

  it('issues secure host-only cookies to the authorized Worker', async () => {
    const response = await publicApp().request('/api/v1/auth/csrf-cookie', {
      headers: { 'X-MineTenant-Origin-Token': originToken },
    });
    await expectStatus(response, 204);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    for (const cookie of response.headers.getSetCookie()) {
      expect(cookie).toMatch(/; Secure(?:;|$)/);
      expect(cookie).toMatch(/; Path=\//);
      expect(cookie).toMatch(/; SameSite=Lax(?:;|$)/);
      expect(cookie).not.toMatch(/; Domain=/);
      expect(/; HttpOnly(?:;|$)/.test(cookie)).toBe(
        !cookie.startsWith('XSRF-TOKEN='),
      );
    }
  });

  it('keeps session authentication and CSRF checks behind the Worker origin guard', async () => {
    const app = publicApp();
    const headers = { 'X-MineTenant-Origin-Token': originToken };
    const me = await app.request('/api/v1/auth/me', { headers });
    await expectStatus(me, 401);
    expect(me.headers.get('Content-Type')).toContain('application/json');
    expect(await me.json()).toEqual({ message: 'Unauthenticated.' });
    await expectStatus(
      await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers,
      }),
      419,
    );
  });

  it('blocks Minecraft, user directory, health, development and unknown paths', async () => {
    const app = publicApp();
    for (const path of [
      '/',
      '/up',
      '/api/hello',
      '/api/v1/users',
      '/api/v1/unknown',
      '/api/v1/minecraft/catalog',
      '/api/v1/minecraft/purchases',
    ]) {
      const response = await app.request(path, {
        headers: { 'X-MineTenant-Origin-Token': originToken },
      });
      await expectStatus(response, 404);
      expect(await response.json()).toEqual({ message: 'Not found.' });
    }
    await expectStatus(
      await app.request('/api/v1/minecraft/purchases', {
        method: 'POST',
        headers: {
          'X-MineTenant-Origin-Token': originToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ buyerId: 'user-buyer' }),
      }),
      404,
    );
  });

  it('preserves local endpoints without origin credentials', async () => {
    const app = publicApp({
      publicTunnel: false,
      originToken: '',
      debug: true,
      sessionSecure: false,
    });
    await expectStatus(await app.request('/api/hello'), 200);
    await expectStatus(await app.request('/api/v1/auth/csrf-cookie'), 204);
    await expectStatus(await app.request('/api/v1/minecraft/catalog'), 200);
  });

  it('trusts only the authenticated Worker client IP from a loopback transport', async () => {
    const app = publicApp();
    app.get('/api/v1/products/proxy-check/headers', (c) =>
      c.json({ ip: c.get('clientIp'), host: new URL(c.req.url).host }),
    );
    const request = {
      headers: {
        'X-MineTenant-Origin-Token': originToken,
        'X-MineTenant-Client-IP': '203.0.113.42',
        'X-Forwarded-For': '198.51.100.99, 2a06:98c0:3600::103',
        'X-Forwarded-Host': 'untrusted.example',
      },
    };
    const proxied = await app.request(
      'http://localhost/api/v1/products/proxy-check/headers',
      request,
      bindings('127.0.0.1'),
    );
    await expectStatus(proxied, 200);
    expect(await proxied.json()).toEqual({
      ip: '203.0.113.42',
      host: 'localhost',
    });
    const direct = await app.request(
      'http://localhost/api/v1/products/proxy-check/headers',
      request,
      bindings('192.0.2.10'),
    );
    await expectStatus(direct, 200);
    expect(await direct.json()).toEqual({
      ip: '192.0.2.10',
      host: 'localhost',
    });
  });

  it('ignores invalid Worker IPs instead of trusting the forwarding chain', async () => {
    const app = publicApp();
    app.get('/api/v1/products/proxy-check/ip', (c) =>
      c.json({ ip: c.get('clientIp') }),
    );
    for (const ip of [
      '',
      'not-an-ip',
      '999.0.0.1',
      '203.0.113.42, 198.51.100.1',
      '2001:db8:::1',
    ]) {
      const response = await app.request(
        '/api/v1/products/proxy-check/ip',
        {
          headers: {
            'X-MineTenant-Origin-Token': originToken,
            'X-MineTenant-Client-IP': ip,
            'X-Forwarded-For': '198.51.100.99, 2a06:98c0:3600::103',
          },
        },
        bindings('127.0.0.1'),
      );
      await expectStatus(response, 200);
      expect(await response.json()).toEqual({ ip: '127.0.0.1' });
    }
  });

  it('accepts IPv6 Worker clients and ignores all proxy headers in local mode', async () => {
    const publicServer = publicApp();
    const localServer = publicApp({ publicTunnel: false });
    for (const app of [publicServer, localServer]) {
      app.get('/api/v1/products/proxy-check/ip', (c) =>
        c.json({ ip: c.get('clientIp') }),
      );
    }
    const request = {
      headers: {
        'X-MineTenant-Origin-Token': originToken,
        'X-MineTenant-Client-IP': '2001:db8::42',
        'X-Forwarded-For': '198.51.100.99',
      },
    };
    const proxied = await publicServer.request(
      '/api/v1/products/proxy-check/ip',
      request,
      bindings('::1'),
    );
    expect(await proxied.json()).toEqual({ ip: '2001:db8::42' });
    const local = await localServer.request(
      '/api/v1/products/proxy-check/ip',
      request,
      bindings('::1'),
    );
    expect(await local.json()).toEqual({ ip: '::1' });
  });

  it('allows configured credentialed origins and responds to preflight without creating sessions', async () => {
    const app = setup.app;
    const response = await app.request('/api/v1/auth/csrf-cookie', {
      headers: { Origin: 'http://localhost:5173' },
    });
    await expectStatus(response, 204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:5173',
    );
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true',
    );
    expect(response.headers.get('Vary')).toContain('Origin');
    const preflight = await app.request('/api/v1/products', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-xsrf-token',
      },
    });
    await expectStatus(preflight, 204);
    expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true',
    );
    expect(
      preflight.headers.get('Access-Control-Allow-Headers')?.toLowerCase(),
    ).toContain('x-xsrf-token');
    expect(preflight.headers.getSetCookie()).toHaveLength(0);
    const rejected = await app.request('/api/v1/auth/csrf-cookie', {
      headers: { Origin: 'https://untrusted.example' },
    });
    expect(rejected.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('preserves CORS, no-store and session cookies on validation/auth/CSRF error responses', async () => {
    const client = createClient(setup.app);
    await client.request('/api/v1/auth/csrf-cookie');
    for (const [path, method, status] of [
      ['/api/v1/auth/me', 'GET', 401],
      ['/api/v1/auth/login', 'POST', 422],
    ] as const) {
      const response = await client.request(path, {
        method,
        headers: { Origin: 'http://localhost:5173' },
      });
      await expectStatus(response, status);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
        'http://localhost:5173',
      );
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
        'true',
      );
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.getSetCookie()).toHaveLength(2);
    }
    const csrfError = await setup.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173' },
    });
    await expectStatus(csrfError, 419);
    expect(csrfError.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:5173',
    );
    expect(csrfError.headers.getSetCookie()).toHaveLength(2);
  });
});
