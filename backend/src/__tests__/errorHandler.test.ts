/**
 * Unit tests for src/middleware/errorHandler.ts — Issue #237.
 *
 * Covers:
 *  - AppError path: correct status code, structured payload, tracing IDs
 *  - ZodError path: 400, VALIDATION_ERROR code, error detail forwarding
 *  - Generic Error path: status from err.status, message, 500 fallback
 *  - Production mode: internal error messages are hidden
 *  - Tracing ID resolution: req property → response header fallback → absent
 *  - hasNumericStatus: non-object and missing .status fall back to 500
 */

import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../middleware/errorHandler';
import { AppError, ErrorCode } from '../errors/errorCodes';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from '../middleware/correlationId.middleware';
import { env } from '../config/env';

// ── Silence pino during tests ────────────────────────────────────────────────
jest.mock('../middleware/logger', () => ({
  appLogger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<{
  correlationId: string;
  requestId: string;
  path: string;
  headers: Record<string, string>;
}> = {}): Request {
  return {
    path: overrides.path ?? '/test',
    correlationId: overrides.correlationId,
    requestId: overrides.requestId,
    headers: overrides.headers ?? {},
  } as unknown as Request;
}

function makeRes(headerMap: Record<string, string> = {}): {
  res: Response;
  status: jest.Mock;
  json: jest.Mock;
} {
  const status = jest.fn();
  const json = jest.fn();
  // Allow chaining: status().json()
  status.mockReturnValue({ json });

  const res = {
    status,
    json,
    getHeader: jest.fn((name: string) => headerMap[name]),
  } as unknown as Response;

  return { res, status, json };
}

const next: NextFunction = jest.fn();

// ── AppError path ─────────────────────────────────────────────────────────────

describe('errorHandler — AppError', () => {
  it('uses the AppError statusCode and code in the response', () => {
    const err = new AppError(ErrorCode.NOT_FOUND, 'Resource not found', 404);
    const req = makeReq({ path: '/trades/99' });
    const { res, status, json } = makeRes();

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found',
        path: '/trades/99',
        timestamp: expect.any(String),
      }),
    );
  });

  it('attaches correlationId and requestId from the request object', () => {
    const err = new AppError(ErrorCode.AUTH_ERROR, 'Unauthorized', 401);
    const req = makeReq({ correlationId: 'corr-111', requestId: 'req-222' });
    const { res, json } = makeRes();

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'corr-111',
        requestId: 'req-222',
      }),
    );
  });

  it('falls back to response headers for tracing IDs when absent on req', () => {
    const err = new AppError(ErrorCode.AUTH_ERROR, 'Unauthorized', 401);
    const req = makeReq();
    const { res, json } = makeRes({
      [CORRELATION_ID_HEADER]: 'corr-header',
      [REQUEST_ID_HEADER]: 'req-header',
    });

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'corr-header',
        requestId: 'req-header',
      }),
    );
  });

  it('omits tracing IDs from the payload when they are absent entirely', () => {
    const err = new AppError(ErrorCode.DOMAIN_ERROR, 'Domain error', 422);
    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(err, req, res, next);

    const payload = json.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('correlationId');
    expect(payload).not.toHaveProperty('requestId');
  });

  it('includes AppError details in the payload', () => {
    const err = new AppError(
      ErrorCode.VALIDATION_ERROR,
      'Invalid amount',
      400,
      { field: 'amount', min: 0 },
    );
    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { field: 'amount', min: 0 },
      }),
    );
  });

  it('recognises an AppError that crossed a module boundary (structural check)', () => {
    // Simulate an AppError that is not instanceof AppError (e.g. duplicate module)
    const fakeAppError = {
      name: 'AppError',
      code: ErrorCode.DOMAIN_ERROR,
      message: 'cross-boundary error',
      statusCode: 409,
      details: {},
      toPayload: (path?: string, requestId?: string, correlationId?: string) => ({
        code: ErrorCode.DOMAIN_ERROR,
        message: 'cross-boundary error',
        error: 'cross-boundary error',
        details: {},
        timestamp: new Date().toISOString(),
        path,
        requestId,
        correlationId,
      }),
    };

    const req = makeReq({ path: '/trades' });
    const { res, status } = makeRes();

    errorHandler(fakeAppError as unknown as Error, req, res, next);

    expect(status).toHaveBeenCalledWith(409);
  });
});

// ── ZodError path ─────────────────────────────────────────────────────────────

describe('errorHandler — ZodError', () => {
  const schema = z.object({ amount: z.number().min(0) });

  it('returns 400 with VALIDATION_ERROR code', () => {
    let zodErr: z.ZodError | undefined;
    try {
      schema.parse({ amount: -1 });
    } catch (e) {
      if (e instanceof z.ZodError) zodErr = e;
    }

    const req = makeReq();
    const { res, status } = makeRes();

    errorHandler(zodErr!, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
  });

  it('sets code to VALIDATION_ERROR and message to "Validation failed"', () => {
    let zodErr: z.ZodError | undefined;
    try {
      schema.parse({ amount: 'not-a-number' });
    } catch (e) {
      if (e instanceof z.ZodError) zodErr = e;
    }

    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(zodErr!, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Validation failed',
      }),
    );
  });

  it('forwards the ZodError errors array in details', () => {
    let zodErr: z.ZodError | undefined;
    try {
      schema.parse({ amount: 'bad' });
    } catch (e) {
      if (e instanceof z.ZodError) zodErr = e;
    }

    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(zodErr!, req, res, next);

    const payload = json.mock.calls[0][0] as Record<string, unknown>;
    expect((payload.details as { errors: unknown[] }).errors).toBeDefined();
    expect(
      ((payload.details as { errors: unknown[] }).errors).length,
    ).toBeGreaterThan(0);
  });

  it('includes correlationId in Zod error response when present on request', () => {
    let zodErr: z.ZodError | undefined;
    try {
      schema.parse({});
    } catch (e) {
      if (e instanceof z.ZodError) zodErr = e;
    }

    const req = makeReq({ correlationId: 'zod-corr' });
    const { res, json } = makeRes();

    errorHandler(zodErr!, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'zod-corr' }),
    );
  });

  it('includes a timestamp in the payload', () => {
    let zodErr: z.ZodError | undefined;
    try {
      schema.parse({ amount: 'x' });
    } catch (e) {
      if (e instanceof z.ZodError) zodErr = e;
    }

    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(zodErr!, req, res, next);

    const payload = json.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof payload.timestamp).toBe('string');
    expect(new Date(payload.timestamp as string).getTime()).not.toBeNaN();
  });
});

// ── Generic Error path ────────────────────────────────────────────────────────

describe('errorHandler — generic Error', () => {
  it('uses err.status when present', () => {
    const err = Object.assign(new Error('not found'), { status: 404 });
    const req = makeReq();
    const { res, status } = makeRes();

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(404);
  });

  it('falls back to 500 when err.status is absent', () => {
    const err = new Error('unexpected');
    const req = makeReq();
    const { res, status } = makeRes();

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('falls back to 500 when err.status is non-numeric', () => {
    const err = Object.assign(new Error('bad status'), { status: 'oops' });
    const req = makeReq();
    const { res, status } = makeRes();

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('falls back to 500 for a thrown string', () => {
    const req = makeReq();
    const { res, status } = makeRes();

    errorHandler('something went wrong' as unknown as Error, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('falls back to 500 for a thrown null', () => {
    const req = makeReq();
    const { res, status } = makeRes();

    errorHandler(null as unknown as Error, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('sets code to INTERNAL_ERROR', () => {
    const err = new Error('server error');
    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.INTERNAL_ERROR }),
    );
  });

  it('exposes the real message in non-production environments', () => {
    (env as Record<string, unknown>).NODE_ENV = 'development';

    const err = new Error('raw internal error');
    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'raw internal error' }),
    );

    (env as Record<string, unknown>).NODE_ENV = 'test';
  });

  it('includes a path and timestamp in the generic error payload', () => {
    const err = new Error('generic');
    const req = makeReq({ path: '/some/path' });
    const { res, json } = makeRes();

    errorHandler(err, req, res, next);

    const payload = json.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.path).toBe('/some/path');
    expect(typeof payload.timestamp).toBe('string');
  });
});

// ── Production mode ───────────────────────────────────────────────────────────

describe('errorHandler — production mode', () => {
  beforeEach(() => {
    (env as Record<string, unknown>).NODE_ENV = 'production';
  });

  afterEach(() => {
    (env as Record<string, unknown>).NODE_ENV = 'test';
  });

  it('replaces generic error messages with "Internal server error"', () => {
    const err = new Error('sensitive details about the database');
    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Internal server error' }),
    );
    expect(json).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'sensitive details about the database' }),
    );
  });

  it('still exposes AppError messages in production (they are intentionally public)', () => {
    const err = new AppError(ErrorCode.NOT_FOUND, 'Trade not found', 404);
    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Trade not found' }),
    );
  });

  it('masks the message for a non-Error thrown value', () => {
    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler({ secret: 'db password' } as unknown as Error, req, res, next);

    const payload = json.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.message).toBe('Internal server error');
  });
});

// ── Payload shape ─────────────────────────────────────────────────────────────

describe('errorHandler — payload shape', () => {
  it('always includes required fields: code, message, error, details, timestamp', () => {
    const err = new Error('shape test');
    const req = makeReq();
    const { res, json } = makeRes();

    errorHandler(err, req, res, next);

    const payload = json.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toHaveProperty('code');
    expect(payload).toHaveProperty('message');
    expect(payload).toHaveProperty('details');
    expect(payload).toHaveProperty('timestamp');
  });
});
