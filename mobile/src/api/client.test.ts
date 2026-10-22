import { AxiosError } from 'axios';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';

type ApiClientModule = typeof import('./client');
type ErrorsModule = typeof import('./errors');
type MappedError = InstanceType<ErrorsModule['AdminApiError']>;

/**
 * Loads a fresh copy of `client.ts` (so interceptor state such as the auth
 * token never leaks between tests) and swaps the network for a stub adapter
 * that records the config that survived the request interceptors.
 *
 * Note: `EXPO_PUBLIC_*` values are inlined by babel-preset-expo at transform
 * time, so env overrides cannot be exercised by mutating `process.env` here —
 * these tests pin the default configuration.
 */
function loadClient() {
  let mod!: ApiClientModule;
  let errors!: ErrorsModule;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    mod = require('./client') as ApiClientModule;
    // Same registry as `mod`, so `instanceof AdminApiError` holds.
    errors = require('./errors') as ErrorsModule;
    /* eslint-enable @typescript-eslint/no-require-imports */
  });

  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push(config);
    return {
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
  mod.default.defaults.adapter = adapter;

  return {
    ...mod,
    apiClient: mod.default,
    AdminApiError: errors.AdminApiError,
    seen,
  };
}

describe('apiClient defaults', () => {
  it('targets localhost:4000 with a 10s timeout when no API URL is configured', () => {
    const { apiClient } = loadClient();

    expect(apiClient.defaults.baseURL).toBe('http://localhost:4000');
    expect(apiClient.defaults.timeout).toBe(10000);
  });
});

describe('Authorization header', () => {
  it('omits the header until a token is set', async () => {
    const { apiClient, seen } = loadClient();

    await apiClient.get('/trades');

    expect(seen[0].headers.get('Authorization')).toBeFalsy();
  });

  it('attaches a Bearer token once setAuthToken is called', async () => {
    const { apiClient, setAuthToken, seen } = loadClient();

    setAuthToken('jwt-123');
    await apiClient.get('/trades');

    expect(seen[0].headers.get('Authorization')).toBe('Bearer jwt-123');
  });

  it('stops sending the header after setAuthToken(null)', async () => {
    const { apiClient, setAuthToken, seen } = loadClient();

    setAuthToken('jwt-123');
    setAuthToken(null);
    await apiClient.get('/trades');

    expect(seen[0].headers.get('Authorization')).toBeFalsy();
  });

  it('uses the most recently set token', async () => {
    const { apiClient, setAuthToken, seen } = loadClient();

    setAuthToken('first');
    setAuthToken('second');
    await apiClient.get('/trades');

    expect(seen[0].headers.get('Authorization')).toBe('Bearer second');
  });
});

describe('API version prefix', () => {
  it.each([
    ['/trades', '/api/v1/trades'],
    ['/trades/42/deposit', '/api/v1/trades/42/deposit'],
    ['/auth/challenge', '/api/v1/auth/challenge'],
  ])('prefixes consumer route %s with /api/v1', async (url, expected) => {
    const { apiClient, seen } = loadClient();

    await apiClient.get(url);

    expect(seen[0].url).toBe(expected);
  });

  it.each([
    ['/admin', '/admin'],
    ['/admin/streams', '/admin/streams'],
    ['/api/admin/contract/fee', '/api/admin/contract/fee'],
    ['/health', '/health'],
    ['/health/ready', '/health/ready'],
  ])('leaves unversioned route %s untouched', async (url, expected) => {
    const { apiClient, seen } = loadClient();

    await apiClient.get(url);

    expect(seen[0].url).toBe(expected);
  });

  it('only treats full path segments as unversioned (/administrators is versioned)', async () => {
    const { apiClient, seen } = loadClient();

    await apiClient.get('/administrators');

    expect(seen[0].url).toBe('/api/v1/administrators');
  });

  it('does not double-prefix URLs that already carry an /api/v* version', async () => {
    const { apiClient, seen } = loadClient();

    await apiClient.get('/api/v1/trades');
    await apiClient.get('/api/v2/trades');

    expect(seen[0].url).toBe('/api/v1/trades');
    expect(seen[1].url).toBe('/api/v2/trades');
  });

  it('leaves absolute URLs untouched', async () => {
    const { apiClient, seen } = loadClient();

    await apiClient.get('https://example.test/some/path');

    expect(seen[0].url).toBe('https://example.test/some/path');
  });
});

describe('error mapping', () => {
  function rejectWith(
    apiClient: ApiClientModule['default'],
    status: number | undefined,
    data?: unknown,
    code?: string,
  ) {
    apiClient.defaults.adapter = async (config) => {
      throw new AxiosError(
        'Request failed',
        code,
        config,
        undefined,
        status === undefined
          ? undefined
          : {
              status,
              data,
              statusText: 'ERR',
              headers: {},
              config,
            },
      );
    };
  }

  it('converts a structured backend error into an AdminApiError', async () => {
    const { apiClient, AdminApiError } = loadClient();
    rejectWith(apiClient, 404, {
      code: 'TRADE_NOT_FOUND',
      message: 'No such trade',
    });

    const error = await apiClient.get('/trades/1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as MappedError).code).toBe('TRADE_NOT_FOUND');
    expect((error as MappedError).status).toBe(404);
  });

  it('maps a 401 without a backend code to AUTH_ERROR', async () => {
    const { apiClient, AdminApiError } = loadClient();
    rejectWith(apiClient, 401, {});

    const error = await apiClient.get('/trades').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as MappedError).code).toBe('AUTH_ERROR');
  });

  it('maps a response-less failure to NETWORK_ERROR', async () => {
    const { apiClient, AdminApiError } = loadClient();
    rejectWith(apiClient, undefined, undefined, 'ERR_NETWORK');

    const error = await apiClient.get('/trades').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as MappedError).code).toBe('NETWORK_ERROR');
  });

  it('maps a timeout to TIMEOUT_ERROR', async () => {
    const { apiClient, AdminApiError } = loadClient();
    rejectWith(apiClient, undefined, undefined, 'ECONNABORTED');

    const error = await apiClient.get('/trades').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as MappedError).code).toBe('TIMEOUT_ERROR');
  });

  it('passes successful responses through unchanged', async () => {
    const { apiClient } = loadClient();

    const response = await apiClient.get('/trades');

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
  });
});
