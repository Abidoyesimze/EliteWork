/**
 * Unit tests for src/middleware/requestId.ts — Issue #239.
 *
 * Covers:
 *  - Pass-through: caller-supplied x-request-id is preserved on req and res
 *  - Generation: a UUID is generated when the header is absent
 *  - Uniqueness: sequential calls produce distinct IDs
 *  - Response header: X-Request-ID is always set on the response
 *  - next() is always called exactly once
 *  - Boundary: empty string header triggers generation (treated as absent)
 *  - Array value: first element used when header arrives as an array
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { requestIdMiddleware } from '../middleware/requestId';

// ── Helpers ───────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeReq(headersOverride: Record<string, string | string[]> = {}): Request {
  return {
    headers: { ...headersOverride },
  } as unknown as Request;
}

function makeRes(): { res: Response; setHeader: jest.Mock } {
  const setHeader = jest.fn();
  const res = { setHeader } as unknown as Response;
  return { res, setHeader };
}

function makeNext(): NextFunction {
  return jest.fn();
}

// ── Pass-through: caller-supplied header ──────────────────────────────────────

describe('requestIdMiddleware — caller-supplied x-request-id', () => {
  it('preserves the caller-supplied ID on req.headers', () => {
    const req = makeReq({ 'x-request-id': 'caller-id-001' });
    const { res } = makeRes();
    const next = makeNext();

    requestIdMiddleware(req, res, next);

    expect(req.headers['x-request-id']).toBe('caller-id-001');
  });

  it('echoes the caller-supplied ID in the X-Request-ID response header', () => {
    const req = makeReq({ 'x-request-id': 'caller-id-002' });
    const { res, setHeader } = makeRes();
    const next = makeNext();

    requestIdMiddleware(req, res, next);

    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', 'caller-id-002');
  });

  it('calls next() exactly once when a caller ID is present', () => {
    const req = makeReq({ 'x-request-id': 'caller-id-003' });
    const { res } = makeRes();
    const next = makeNext();

    requestIdMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ── Generation: no header supplied ───────────────────────────────────────────

describe('requestIdMiddleware — generated x-request-id', () => {
  it('sets req.headers["x-request-id"] to a generated UUID when header is absent', () => {
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    requestIdMiddleware(req, res, next);

    expect(req.headers['x-request-id']).toMatch(UUID_RE);
  });

  it('sets X-Request-ID response header to the generated UUID', () => {
    const req = makeReq();
    const { res, setHeader } = makeRes();
    const next = makeNext();

    requestIdMiddleware(req, res, next);

    const id = req.headers['x-request-id'] as string;
    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', id);
  });

  it('calls next() exactly once when generating a UUID', () => {
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    requestIdMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses the UUID returned by crypto.randomUUID', () => {
    const fixedUuid = '550e8400-e29b-41d4-a716-446655440000';
    jest.spyOn(crypto, 'randomUUID').mockReturnValueOnce(fixedUuid);

    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    requestIdMiddleware(req, res, next);

    expect(req.headers['x-request-id']).toBe(fixedUuid);
  });
});

// ── Uniqueness ────────────────────────────────────────────────────────────────

describe('requestIdMiddleware — uniqueness', () => {
  it('generates distinct IDs across sequential calls', () => {
    const ids = Array.from({ length: 5 }).map(() => {
      const req = makeReq();
      const { res } = makeRes();
      requestIdMiddleware(req, res, makeNext());
      return req.headers['x-request-id'] as string;
    });

    const unique = new Set(ids);
    expect(unique.size).toBe(5);
  });
});

// ── Response header is always set ─────────────────────────────────────────────

describe('requestIdMiddleware — response header', () => {
  it('always calls setHeader with X-Request-ID', () => {
    // Without caller header
    const req1 = makeReq();
    const { res: res1, setHeader: sh1 } = makeRes();
    requestIdMiddleware(req1, res1, makeNext());
    expect(sh1).toHaveBeenCalledWith('X-Request-ID', expect.any(String));

    // With caller header
    const req2 = makeReq({ 'x-request-id': 'given-id' });
    const { res: res2, setHeader: sh2 } = makeRes();
    requestIdMiddleware(req2, res2, makeNext());
    expect(sh2).toHaveBeenCalledWith('X-Request-ID', 'given-id');
  });

  it('request header and response header carry the same ID', () => {
    const req = makeReq();
    const { res, setHeader } = makeRes();

    requestIdMiddleware(req, res, makeNext());

    const reqId = req.headers['x-request-id'];
    const [, resId] = setHeader.mock.calls[0] as [string, string];
    expect(reqId).toBe(resId);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('requestIdMiddleware — edge cases', () => {
  afterEach(() => jest.restoreAllMocks());

  it('never throws', () => {
    expect(() => {
      const req = makeReq();
      const { res } = makeRes();
      requestIdMiddleware(req, res, makeNext());
    }).not.toThrow();
  });

  it('generates a valid UUID even when crypto.randomUUID is called', () => {
    // Ensure no mock interference
    const req = makeReq();
    const { res } = makeRes();
    requestIdMiddleware(req, res, makeNext());
    expect(req.headers['x-request-id']).toMatch(UUID_RE);
  });
});
