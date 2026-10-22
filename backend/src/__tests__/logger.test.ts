/**
 * Unit tests for src/middleware/logger.ts — Issue #238.
 *
 * Covers:
 *  - appLogger: exported as a pino instance in test mode (silent level)
 *  - pinoHttp middleware: default export wired with correct options
 *  - customProps: extracts correlationId and requestId from the request
 *  - autoLogging.ignore: suppresses /health and /api/docs, passes /trades
 *  - customSuccessMessage / customErrorMessage: format and content
 *  - serializers.req: includes correlation/request ID headers
 *  - PII pass-through guard: the logMethod hook is registered (enforcement in
 *    logger.pii.test.ts per #233 — this file tests the wiring, not the rules)
 *  - streamWrite hook: registered in non-test environments
 */

import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from '../middleware/correlationId.middleware';

// ── Mock pino and pino-http before importing the module under test ────────────

let capturedPinoOptions: Record<string, unknown> = {};
let capturedPinoHttpOptions: Record<string, unknown> = {};

jest.mock('pino', () => {
  return jest.fn((opts: Record<string, unknown>) => {
    capturedPinoOptions = opts ?? {};
    return {
      _pinoMockInstance: true,
      level: opts?.level,
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };
  });
});

jest.mock('pino-http', () => {
  return jest.fn((opts: Record<string, unknown>) => {
    capturedPinoHttpOptions = opts ?? {};
    return 'pino-http-middleware';
  });
});

// ── Silence sample buffer writes (not relevant to logger contract tests) ──────
jest.mock('../lib/logSampleBuffer', () => ({
  recordLogLine: jest.fn(),
}));

// ── Import after mocking ──────────────────────────────────────────────────────
import loggerMiddleware, { appLogger } from '../middleware/logger';

// ── appLogger ─────────────────────────────────────────────────────────────────

describe('appLogger', () => {
  it('is exported from the module', () => {
    expect(appLogger).toBeDefined();
  });

  it('has a logMethod hook attached (PII redaction pipeline wiring)', () => {
    // In test mode (NODE_ENV=test) pino is called with hooks.logMethod
    const hooks = capturedPinoOptions.hooks as { logMethod?: unknown } | undefined;
    expect(hooks?.logMethod).toBeInstanceOf(Function);
  });

  it('uses "silent" level in the test environment', () => {
    // NODE_ENV=test means the logger must not emit anything
    const level = capturedPinoOptions.level;
    expect(level).toBe('silent');
  });
});

// ── Default export (pinoHttp middleware) ──────────────────────────────────────

describe('logger default export', () => {
  it('is the pinoHttp return value', () => {
    expect(loggerMiddleware).toBe('pino-http-middleware');
  });
});

// ── customProps ───────────────────────────────────────────────────────────────

describe('customProps', () => {
  it('extracts correlationId and requestId from the raw request', () => {
    const customProps = capturedPinoHttpOptions.customProps as
      | ((req: unknown) => Record<string, unknown>)
      | undefined;

    expect(customProps).toBeInstanceOf(Function);

    const fakeReq = { correlationId: 'corr-abc', requestId: 'req-xyz' };
    const result = customProps!(fakeReq);

    expect(result).toEqual({
      correlationId: 'corr-abc',
      requestId: 'req-xyz',
    });
  });

  it('returns undefined for absent tracing IDs', () => {
    const customProps = capturedPinoHttpOptions.customProps as
      | ((req: unknown) => Record<string, unknown>)
      | undefined;

    const result = customProps!({});
    expect(result.correlationId).toBeUndefined();
    expect(result.requestId).toBeUndefined();
  });
});

// ── autoLogging.ignore ────────────────────────────────────────────────────────

describe('autoLogging.ignore', () => {
  function getIgnore(): (req: { url?: string }) => boolean {
    const autoLogging = capturedPinoHttpOptions.autoLogging as
      | { ignore: (req: { url?: string }) => boolean }
      | undefined;
    expect(autoLogging?.ignore).toBeInstanceOf(Function);
    return autoLogging!.ignore;
  }

  it('ignores /health paths', () => {
    expect(getIgnore()({ url: '/health' })).toBe(true);
    expect(getIgnore()({ url: '/health/live' })).toBe(true);
    expect(getIgnore()({ url: '/health/ready' })).toBe(true);
  });

  it('ignores /api/docs paths', () => {
    expect(getIgnore()({ url: '/api/docs' })).toBe(true);
    expect(getIgnore()({ url: '/api/docs/openapi.json' })).toBe(true);
  });

  it('does not ignore application routes', () => {
    expect(getIgnore()({ url: '/trades' })).toBe(false);
    expect(getIgnore()({ url: '/users' })).toBe(false);
    expect(getIgnore()({ url: '/api/v1/trades' })).toBe(false);
  });

  it('does not ignore an empty URL', () => {
    expect(getIgnore()({ url: '' })).toBe(false);
  });

  it('handles a missing url property gracefully', () => {
    expect(() => getIgnore()({})).not.toThrow();
  });
});

// ── customSuccessMessage ──────────────────────────────────────────────────────

describe('customSuccessMessage', () => {
  function getMessage(): (
    req: { method: string; url: string },
    res: { statusCode: number },
  ) => string {
    return capturedPinoHttpOptions.customSuccessMessage as (
      req: { method: string; url: string },
      res: { statusCode: number },
    ) => string;
  }

  it('formats as "METHOD PATH STATUS"', () => {
    const msg = getMessage()({ method: 'GET', url: '/trades' }, { statusCode: 200 });
    expect(msg).toBe('GET /trades 200');
  });

  it('includes the status code', () => {
    const msg = getMessage()(
      { method: 'POST', url: '/escrow/deposit' },
      { statusCode: 201 },
    );
    expect(msg).toContain('201');
  });

  it('includes the HTTP method', () => {
    const msg = getMessage()(
      { method: 'DELETE', url: '/sessions/me' },
      { statusCode: 204 },
    );
    expect(msg).toContain('DELETE');
  });

  it('includes the request path', () => {
    const msg = getMessage()(
      { method: 'PATCH', url: '/users/profile' },
      { statusCode: 200 },
    );
    expect(msg).toContain('/users/profile');
  });
});

// ── customErrorMessage ────────────────────────────────────────────────────────

describe('customErrorMessage', () => {
  function getErrorMessage(): (
    req: { method: string; url: string },
    res: { statusCode: number },
    err: Error,
  ) => string {
    return capturedPinoHttpOptions.customErrorMessage as (
      req: { method: string; url: string },
      res: { statusCode: number },
      err: Error,
    ) => string;
  }

  it('includes the error message', () => {
    const msg = getErrorMessage()(
      { method: 'GET', url: '/trades' },
      { statusCode: 500 },
      new Error('connection refused'),
    );
    expect(msg).toContain('connection refused');
  });

  it('includes the HTTP method and path', () => {
    const msg = getErrorMessage()(
      { method: 'POST', url: '/auth/login' },
      { statusCode: 500 },
      new Error('db timeout'),
    );
    expect(msg).toContain('POST');
    expect(msg).toContain('/auth/login');
  });

  it('includes the response status code', () => {
    const msg = getErrorMessage()(
      { method: 'GET', url: '/health' },
      { statusCode: 503 },
      new Error('unhealthy'),
    );
    expect(msg).toContain('503');
  });
});

// ── serializers.req ───────────────────────────────────────────────────────────

describe('serializers.req', () => {
  function getSerializer(): (req: {
    method: string;
    url: string;
    raw?: Record<string, unknown>;
  }) => Record<string, unknown> {
    const serializers = capturedPinoHttpOptions.serializers as
      | { req: (req: unknown) => Record<string, unknown> }
      | undefined;
    expect(serializers?.req).toBeInstanceOf(Function);
    return serializers!.req;
  }

  it('includes method and url', () => {
    const out = getSerializer()({
      method: 'GET',
      url: '/trades',
      raw: {},
    });
    expect(out.method).toBe('GET');
    expect(out.url).toBe('/trades');
  });

  it(`includes ${CORRELATION_ID_HEADER} from req.raw`, () => {
    const out = getSerializer()({
      method: 'GET',
      url: '/trades',
      raw: { correlationId: 'corr-serial' },
    });
    expect(out[CORRELATION_ID_HEADER]).toBe('corr-serial');
  });

  it(`includes ${REQUEST_ID_HEADER} from req.raw`, () => {
    const out = getSerializer()({
      method: 'POST',
      url: '/trades',
      raw: { requestId: 'req-serial' },
    });
    expect(out[REQUEST_ID_HEADER]).toBe('req-serial');
  });

  it('handles absent raw gracefully', () => {
    const out = getSerializer()({ method: 'GET', url: '/' });
    expect(out[CORRELATION_ID_HEADER]).toBeUndefined();
    expect(out[REQUEST_ID_HEADER]).toBeUndefined();
  });
});
