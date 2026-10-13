import { describe, expect, it } from 'vitest';
import { parseBody, parseJsonBody } from '../src/domain/validation.js';

function jsonRequest(body: string, contentType = 'application/json'): Request {
  return new Request('http://localhost/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
}

describe('parseJsonBody', () => {
  it.each([
    'application/json',
    'Application/JSON; Charset=UTF-8',
    'application/problem+json',
    'application/vnd.minetenant.login+json;version=1',
  ])('accepts the JSON media type %s', async (contentType) => {
    await expect(
      parseJsonBody(jsonRequest('{"username":"demo"}', contentType)),
    ).resolves.toEqual({ username: 'demo' });
  });

  it.each([undefined, '', 'text/json', 'text/plain', 'application/xml'])(
    'rejects the non-JSON media type %j',
    async (contentType) => {
      const headers = contentType ? { 'Content-Type': contentType } : undefined;
      const request = new Request('http://localhost/api/v1/auth/login', {
        method: 'POST',
        headers,
        body: '{}',
      });

      await expect(parseJsonBody(request)).rejects.toMatchObject({
        status: 415,
        message: 'Content-Type must be application/json.',
      });
    },
  );

  it('rejects malformed JSON', async () => {
    await expect(parseJsonBody(jsonRequest('{'))).rejects.toMatchObject({
      status: 400,
      message: 'Invalid JSON.',
    });
  });

  it.each(['', 'null', '[]', '"value"', '1', 'true'])(
    'maps a non-object JSON body %j to an empty input',
    async (body) => {
      await expect(parseJsonBody(jsonRequest(body))).resolves.toEqual({});
    },
  );

  it('preserves raw credential strings without normalization', async () => {
    const input = {
      username: '  Demo_User  ',
      password: '  secret  ',
      empty: '',
    };

    await expect(
      parseJsonBody(jsonRequest(JSON.stringify(input))),
    ).resolves.toEqual(input);
  });

  it('leaves the legacy parser normalization behavior unchanged', async () => {
    await expect(
      parseBody(
        jsonRequest(
          JSON.stringify({ username: '  demo  ', password: '  secret  ' }),
        ),
      ),
    ).resolves.toEqual({ username: 'demo', password: '  secret  ' });
  });
});
