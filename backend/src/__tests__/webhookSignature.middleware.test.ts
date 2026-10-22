/**
 * Unit tests for src/middleware/webhookSignature.middleware.ts — Issue #240.
 *
 * Covers the pure, route-agnostic units exported by the module:
 *
 *  parseWebhookSecrets
 *    - empty / blank input → empty registry
 *    - lowercasing of provider names
 *    - comma-separated rotation secrets
 *    - rejects non-JSON, arrays, non-string values, and empty entries
 *
 *  captureRawBody
 *    - stores a copy of the buffer on req.rawBody
 *    - does not overwrite when buf is empty
 *
 *  computeWebhookSignature
 *    - binds the timestamp into the digest
 *    - matches a hand-computed HMAC-SHA256
 *    - accepts a Buffer rawBody
 *
 *  verifyWebhookSignature (middleware factory)
 *    - calls next() for a valid signature
 *    - rejects unknown_provider (empty/missing provider)
 *    - rejects missing_secret  (provider not in registry)
 *    - rejects missing_signature
 *    - rejects missing_timestamp
 *    - rejects malformed_timestamp (non-numeric)
 *    - rejects stale_timestamp (outside replay window)
 *    - rejects missing_raw_body
 *    - rejects invalid_signature (wrong secret / tampered body)
 *    - accepts both old and new secret during rotation
 *    - uses options.provider over req.params.provider
 *    - uses options.toleranceSeconds over env default
 *
 *  resetWebhookSecretRegistry / configuredWebhookProviders
 *    - invalidates the cache after an env change
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

// ── Proxy env so tests can mutate INBOUND_WEBHOOK_SECRETS mid-run ─────────────
jest.mock('../config/env', () => {
  const actual = jest.requireActual('../config/env');
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target: Record<string, unknown>, key: string) {
        if (key === 'INBOUND_WEBHOOK_SECRETS') {
          return process.env.INBOUND_WEBHOOK_SECRETS;
        }
        if (key === 'INBOUND_WEBHOOK_TOLERANCE_SECONDS') {
          return Number(process.env.INBOUND_WEBHOOK_TOLERANCE_SECONDS ?? 300);
        }
        return target[key];
      },
    }),
  };
});

// ── Silence appLogger ─────────────────────────────────────────────────────────
jest.mock('../middleware/logger', () => ({
  appLogger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ── Mock metrics ──────────────────────────────────────────────────────────────
const mockRecord = jest.fn<void, [string, string]>();
jest.mock('../lib/metrics', () => ({
  recordWebhookSignatureVerification: mockRecord,
}));

import {
  captureRawBody,
  computeWebhookSignature,
  configuredWebhookProviders,
  parseWebhookSecrets,
  RawBodyRequest,
  resetWebhookSecretRegistry,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../middleware/webhookSignature.middleware';

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function makeBody(obj: unknown = { event: 'test' }): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

function buildSignedHeaders(
  secret: string,
  rawBody: Buffer,
  timestampOverride?: number,
): { [WEBHOOK_SIGNATURE_HEADER]: string; [WEBHOOK_TIMESTAMP_HEADER]: string } {
  const timestamp = String(timestampOverride ?? nowSeconds());
  const sig = computeWebhookSignature(secret, timestamp, rawBody);
  return {
    [WEBHOOK_SIGNATURE_HEADER]: sig,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
  };
}

type ReqOverrides = {
  provider?: string;
  rawBody?: Buffer;
  signatureHeader?: string;
  timestampHeader?: string;
  params?: Record<string, string>;
};

function makeReq(overrides: ReqOverrides = {}): RawBodyRequest {
  const headers: Record<string, string> = {};
  if (overrides.signatureHeader !== undefined) {
    headers[WEBHOOK_SIGNATURE_HEADER] = overrides.signatureHeader;
  }
  if (overrides.timestampHeader !== undefined) {
    headers[WEBHOOK_TIMESTAMP_HEADER] = overrides.timestampHeader;
  }

  return {
    headers,
    params: overrides.params ?? { provider: overrides.provider ?? '' },
    rawBody: overrides.rawBody,
    originalUrl: '/webhooks/inbound/test',
    ip: '127.0.0.1',
  } as unknown as RawBodyRequest;
}

function makeRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return {
    res: { status, json, getHeader: jest.fn() } as unknown as Response,
    status,
    json,
  };
}

const SECRET = 'test-webhook-secret-value';
const PROVIDER = 'test-provider';
const DEFAULT_SECRETS = JSON.stringify({ [PROVIDER]: SECRET });

// ── parseWebhookSecrets ───────────────────────────────────────────────────────

describe('parseWebhookSecrets', () => {
  it('returns an empty Map for undefined', () => {
    expect(parseWebhookSecrets(undefined).size).toBe(0);
  });

  it('returns an empty Map for a blank string', () => {
    expect(parseWebhookSecrets('   ').size).toBe(0);
  });

  it('returns an empty Map for an empty string', () => {
    expect(parseWebhookSecrets('').size).toBe(0);
  });

  it('registers a single provider and secret', () => {
    const registry = parseWebhookSecrets(JSON.stringify({ provider: 'secret' }));
    expect(registry.get('provider')).toEqual(['secret']);
  });

  it('lowercases provider names', () => {
    const registry = parseWebhookSecrets(JSON.stringify({ 'MY-Provider': 'sec' }));
    expect(registry.has('my-provider')).toBe(true);
    expect(registry.has('MY-Provider')).toBe(false);
  });

  it('splits comma-separated rotation secrets', () => {
    const registry = parseWebhookSecrets(JSON.stringify({ p: 'old-secret , new-secret' }));
    expect(registry.get('p')).toEqual(['old-secret', 'new-secret']);
  });

  it('trims whitespace around individual secrets', () => {
    const registry = parseWebhookSecrets(JSON.stringify({ p: ' a , b , c ' }));
    expect(registry.get('p')).toEqual(['a', 'b', 'c']);
  });

  it('throws when given non-JSON input', () => {
    expect(() => parseWebhookSecrets('not json')).toThrow(/must be a JSON object/);
  });

  it('throws when given a JSON array', () => {
    expect(() => parseWebhookSecrets('["a"]')).toThrow(/must be a JSON object/);
  });

  it('throws when a provider value is not a string', () => {
    expect(() => parseWebhookSecrets('{"p":123}')).toThrow(/must be a string/);
  });

  it('throws when a provider secret string is empty after trimming', () => {
    expect(() => parseWebhookSecrets('{"p":" , "}')).toThrow(/is empty/);
  });

  it('handles multiple providers', () => {
    const registry = parseWebhookSecrets(
      JSON.stringify({ provA: 'secA', provB: 'secB' }),
    );
    expect(registry.size).toBe(2);
    expect(registry.get('prova')).toEqual(['secA']);
    expect(registry.get('provb')).toEqual(['secB']);
  });
});

// ── captureRawBody ────────────────────────────────────────────────────────────

describe('captureRawBody', () => {
  it('stores a copy of the buffer on req.rawBody', () => {
    const req = {} as RawBodyRequest;
    const buf = Buffer.from('{"event":"test"}');
    captureRawBody(req, {} as Response, buf);
    expect(req.rawBody).toBeDefined();
    expect(req.rawBody!.toString()).toBe('{"event":"test"}');
  });

  it('does not modify req.rawBody when buf is empty', () => {
    const req = {} as RawBodyRequest;
    captureRawBody(req, {} as Response, Buffer.alloc(0));
    expect(req.rawBody).toBeUndefined();
  });

  it('does not modify req.rawBody when buf is falsy', () => {
    const req = {} as RawBodyRequest;
    // @ts-expect-error: testing defensive branch
    captureRawBody(req, {} as Response, null);
    expect(req.rawBody).toBeUndefined();
  });

  it('stores a copy, not the same buffer reference', () => {
    const req = {} as RawBodyRequest;
    const buf = Buffer.from('hello');
    captureRawBody(req, {} as Response, buf);
    buf.write('XXXXX');
    expect(req.rawBody!.toString()).toBe('hello');
  });
});

// ── computeWebhookSignature ───────────────────────────────────────────────────

describe('computeWebhookSignature', () => {
  it('produces a hex string', () => {
    const sig = computeWebhookSignature('secret', '1000', 'body');
    expect(typeof sig).toBe('string');
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });

  it('matches a hand-computed HMAC-SHA256 over `${timestamp}.${body}`', () => {
    const expected = crypto
      .createHmac('sha256', 'sec')
      .update('1234.')
      .update('{"event":"x"}')
      .digest('hex');
    expect(computeWebhookSignature('sec', '1234', '{"event":"x"}')).toBe(expected);
  });

  it('binds the timestamp into the digest (different timestamps → different sigs)', () => {
    const body = '{"event":"x"}';
    const a = computeWebhookSignature('s', '1000', body);
    const b = computeWebhookSignature('s', '2000', body);
    expect(a).not.toBe(b);
  });

  it('accepts a Buffer as rawBody', () => {
    const buf = Buffer.from('{"event":"x"}');
    const str = '{"event":"x"}';
    const sigBuf = computeWebhookSignature('s', '1000', buf);
    const sigStr = computeWebhookSignature('s', '1000', str);
    expect(sigBuf).toBe(sigStr);
  });

  it('produces different sigs for different secrets', () => {
    const a = computeWebhookSignature('secret-a', '1000', 'body');
    const b = computeWebhookSignature('secret-b', '1000', 'body');
    expect(a).not.toBe(b);
  });
});

// ── verifyWebhookSignature ────────────────────────────────────────────────────

describe('verifyWebhookSignature — pass-through (calls next)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INBOUND_WEBHOOK_SECRETS = DEFAULT_SECRETS;
    process.env.INBOUND_WEBHOOK_TOLERANCE_SECONDS = '300';
    resetWebhookSecretRegistry();
  });

  it('calls next() when the signature is valid', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders(SECRET, rawBody);
    const req = makeReq({
      provider: PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'verified');
  });

  it('uses options.provider over req.params.provider', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders(SECRET, rawBody);
    // params.provider is something else; options.provider is the real one
    const req = makeReq({
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
      params: { provider: 'wrong-provider' },
    });
    const { res } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature({ provider: PROVIDER })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses options.toleranceSeconds over the env default', () => {
    // Use a very short tolerance (1 s) — a 2-second-old timestamp must fail
    const rawBody = makeBody();
    const staleTimestamp = nowSeconds() - 2;
    const headers = buildSignedHeaders(SECRET, rawBody, staleTimestamp);
    const req = makeReq({
      provider: PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature({ toleranceSeconds: 1 })(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'stale_timestamp');
  });
});

describe('verifyWebhookSignature — rejection cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INBOUND_WEBHOOK_SECRETS = DEFAULT_SECRETS;
    process.env.INBOUND_WEBHOOK_TOLERANCE_SECONDS = '300';
    resetWebhookSecretRegistry();
  });

  it('rejects with 404 for an empty/unknown provider', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders(SECRET, rawBody);
    const req = makeReq({
      provider: '',
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(404);
    expect(mockRecord).toHaveBeenCalledWith('unknown', 'unknown_provider');
  });

  it('rejects with 503 when provider secret is not configured', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders(SECRET, rawBody);
    const req = makeReq({
      provider: 'unconfigured-provider',
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
    expect(mockRecord).toHaveBeenCalledWith('unconfigured-provider', 'missing_secret');
  });

  it('rejects with 401 when the signature header is absent', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders(SECRET, rawBody);
    const req = makeReq({
      provider: PROVIDER,
      rawBody,
      // No signatureHeader
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'missing_signature');
  });

  it('rejects with 401 when the timestamp header is absent', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders(SECRET, rawBody);
    const req = makeReq({
      provider: PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      // No timestampHeader
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'missing_timestamp');
  });

  it('rejects with 400 for a non-numeric timestamp', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders(SECRET, rawBody);
    const req = makeReq({
      provider: PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: 'not-a-number',
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'malformed_timestamp');
  });

  it('rejects with 400 for a floating-point timestamp', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders(SECRET, rawBody);
    const req = makeReq({
      provider: PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: '1700000000.5',
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'malformed_timestamp');
  });

  it('rejects with 401 for a stale timestamp (outside replay window)', () => {
    const rawBody = makeBody();
    const staleTs = nowSeconds() - 3600; // 1 hour ago
    const headers = buildSignedHeaders(SECRET, rawBody, staleTs);
    const req = makeReq({
      provider: PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'stale_timestamp');
  });

  it('rejects with 401 for a timestamp skewed far into the future', () => {
    const rawBody = makeBody();
    const futureTs = nowSeconds() + 3600; // 1 hour ahead
    const headers = buildSignedHeaders(SECRET, rawBody, futureTs);
    const req = makeReq({
      provider: PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'stale_timestamp');
  });

  it('rejects with 400 when rawBody is absent', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders(SECRET, rawBody);
    // Do NOT attach rawBody to the request
    const req = makeReq({
      provider: PROVIDER,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'missing_raw_body');
  });

  it('rejects with 401 when the signature does not match', () => {
    const rawBody = makeBody();
    const headers = buildSignedHeaders('wrong-secret', rawBody);
    const req = makeReq({
      provider: PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'invalid_signature');
  });

  it('rejects a tampered body that carries the original signature', () => {
    const originalBody = makeBody({ event: 'payout', amount: '1.00' });
    const headers = buildSignedHeaders(SECRET, originalBody);
    // Body on the wire is different from what was signed
    const tamperedBody = makeBody({ event: 'payout', amount: '99999.00' });
    const req = makeReq({
      provider: PROVIDER,
      rawBody: tamperedBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res, status } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(mockRecord).toHaveBeenCalledWith(PROVIDER, 'invalid_signature');
  });
});

// ── Secret rotation ───────────────────────────────────────────────────────────

describe('verifyWebhookSignature — secret rotation', () => {
  const OLD_SECRET = 'rotation-old-secret';
  const NEW_SECRET = 'rotation-new-secret';
  const ROT_PROVIDER = 'rotation-provider';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INBOUND_WEBHOOK_SECRETS = JSON.stringify({
      [ROT_PROVIDER]: `${OLD_SECRET},${NEW_SECRET}`,
    });
    process.env.INBOUND_WEBHOOK_TOLERANCE_SECONDS = '300';
    resetWebhookSecretRegistry();
  });

  it('accepts a payload signed with the old secret', () => {
    const rawBody = makeBody({ event: 'charge' });
    const headers = buildSignedHeaders(OLD_SECRET, rawBody);
    const req = makeReq({
      provider: ROT_PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(ROT_PROVIDER, 'verified');
  });

  it('accepts a payload signed with the new secret', () => {
    const rawBody = makeBody({ event: 'charge' });
    const headers = buildSignedHeaders(NEW_SECRET, rawBody);
    const req = makeReq({
      provider: ROT_PROVIDER,
      rawBody,
      signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
      timestampHeader: headers[WEBHOOK_TIMESTAMP_HEADER],
    });
    const { res } = makeRes();
    const next = jest.fn() as NextFunction;

    verifyWebhookSignature()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(ROT_PROVIDER, 'verified');
  });
});

// ── resetWebhookSecretRegistry / configuredWebhookProviders ──────────────────

describe('resetWebhookSecretRegistry and configuredWebhookProviders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INBOUND_WEBHOOK_SECRETS = JSON.stringify({
      'provider-a': 'secret-a',
      'provider-b': 'secret-b',
    });
    resetWebhookSecretRegistry();
  });

  it('lists configured providers after setting INBOUND_WEBHOOK_SECRETS', () => {
    const providers = configuredWebhookProviders();
    expect(providers).toContain('provider-a');
    expect(providers).toContain('provider-b');
  });

  it('reflects a new env value after resetWebhookSecretRegistry is called', () => {
    process.env.INBOUND_WEBHOOK_SECRETS = JSON.stringify({ 'new-provider': 'secret' });
    resetWebhookSecretRegistry();

    const providers = configuredWebhookProviders();
    expect(providers).toContain('new-provider');
    expect(providers).not.toContain('provider-a');
  });

  it('returns an empty list when INBOUND_WEBHOOK_SECRETS is unset', () => {
    delete process.env.INBOUND_WEBHOOK_SECRETS;
    resetWebhookSecretRegistry();

    expect(configuredWebhookProviders()).toHaveLength(0);
  });
});
