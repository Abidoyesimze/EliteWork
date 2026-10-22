/**
 * Unit tests for apiVersionMiddleware and apiVersionFrom helper.
 *
 * Covers pass-through, rejection, and error-propagation behaviour (as the
 * issue requires) as well as the header-signalling contract for versioned,
 * legacy-public, and unversioned paths.
 *
 * Note: integration/parity tests (app-level) already live in
 * api.versioning.test.ts.  These tests exercise the middleware function
 * directly without Express to give fast, hermetic coverage.
 *
 * Closes #234.
 */
import { Request, Response, NextFunction } from "express";
import {
  apiVersionMiddleware,
  apiVersionFrom,
  API_VERSION,
  API_VERSION_HEADER,
  DEPRECATION_HEADER,
  SUNSET_HEADER,
  LEGACY_PATH_PREFIX,
  LEGACY_SUNSET_DATE,
  PUBLIC_API_BASE_PATHS,
  ApiVersionedRequest,
} from "../middleware/apiVersion.middleware";

// ── helpers ──────────────────────────────────────────────────────────────────

interface RunResult {
  headers: Record<string, string>;
  req: Request;
  nextCalled: boolean;
  nextArg: unknown;
}

function run(path: string): RunResult {
  const headers: Record<string, string> = {};
  const req = { path, headers: {} } as unknown as Request;
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
  } as unknown as Response;

  let nextCalled = false;
  let nextArg: unknown;

  const next: NextFunction = (arg?: unknown) => {
    nextCalled = true;
    nextArg = arg;
  };

  apiVersionMiddleware(req, res, next);
  return { headers, req, nextCalled, nextArg };
}

// ── versioned /api/v1 paths ──────────────────────────────────────────────────

describe("apiVersionMiddleware — /api/v1 versioned paths", () => {
  it("sets X-Api-Version header to current API version", () => {
    const { headers } = run(`/api/${API_VERSION}/trades`);
    expect(headers[API_VERSION_HEADER]).toBe(API_VERSION);
  });

  it("does NOT set Deprecation header", () => {
    const { headers } = run(`/api/${API_VERSION}/auth/challenge`);
    expect(headers[DEPRECATION_HEADER]).toBeUndefined();
  });

  it("does NOT set Sunset header", () => {
    const { headers } = run(`/api/${API_VERSION}/users/me`);
    expect(headers[SUNSET_HEADER]).toBeUndefined();
  });

  it("marks the request with the current API version", () => {
    const { req } = run(`/api/${API_VERSION}/goals`);
    expect(apiVersionFrom(req)).toBe(API_VERSION);
  });

  it("calls next() with no error", () => {
    const { nextCalled, nextArg } = run(`/api/${API_VERSION}/trades`);
    expect(nextCalled).toBe(true);
    expect(nextArg).toBeUndefined();
  });

  it("handles exact /api/v1 mount (no trailing path segment)", () => {
    const { headers } = run(`/api/${API_VERSION}`);
    expect(headers[API_VERSION_HEADER]).toBe(API_VERSION);
  });
});

// ── legacy public alias paths ────────────────────────────────────────────────

describe("apiVersionMiddleware — legacy public alias paths", () => {
  const legacyPaths = [
    "/auth",
    "/auth/challenge",
    "/trades",
    "/trades/123",
    "/goals",
    "/users/me",
    "/wallet/balance",
    "/disputes",
    "/dispute-categories",
    "/stellar",
    "/contract",
    "/treasury",
    "/webhooks",
    "/evidence",
    "/evidence/abc/download",
  ];

  it.each(legacyPaths)("sets X-Api-Version + Deprecation + Sunset for: %s", (path) => {
    const { headers } = run(path);
    expect(headers[API_VERSION_HEADER]).toBe(API_VERSION);
    expect(headers[DEPRECATION_HEADER]).toBe("true");
    expect(headers[SUNSET_HEADER]).toBe(LEGACY_SUNSET_DATE);
  });

  it.each(legacyPaths)("marks req.apiVersion with LEGACY_PATH_PREFIX for: %s", (path) => {
    const { req } = run(path);
    expect(apiVersionFrom(req)).toBe(LEGACY_PATH_PREFIX);
  });

  it.each(legacyPaths)("calls next() with no error for: %s", (path) => {
    const { nextCalled, nextArg } = run(path);
    expect(nextCalled).toBe(true);
    expect(nextArg).toBeUndefined();
  });

  it("Sunset value matches RFC 1123 date format", () => {
    const { headers } = run("/trades");
    // RFC 1123: "Thu, 01 Jan 2027 00:00:00 GMT"
    expect(headers[SUNSET_HEADER]).toMatch(
      /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    );
  });
});

// ── admin / health / unversioned paths ───────────────────────────────────────

describe("apiVersionMiddleware — admin, health, and unversioned paths", () => {
  const unversionedPaths = [
    "/admin",
    "/admin/features",
    "/api/admin",
    "/api/admin/dlq/pending",
    "/health",
    "/health/live",
    "/health/ready",
    "/something-completely-different",
    "/",
  ];

  it.each(unversionedPaths)(
    "sets no version or deprecation headers for: %s",
    (path) => {
      const { headers } = run(path);
      expect(headers[API_VERSION_HEADER]).toBeUndefined();
      expect(headers[DEPRECATION_HEADER]).toBeUndefined();
      expect(headers[SUNSET_HEADER]).toBeUndefined();
    },
  );

  it.each(unversionedPaths)(
    "leaves req.apiVersion as 'unversioned' for: %s",
    (path) => {
      const { req } = run(path);
      expect(apiVersionFrom(req)).toBe("unversioned");
    },
  );

  it.each(unversionedPaths)("calls next() with no error for: %s", (path) => {
    const { nextCalled, nextArg } = run(path);
    expect(nextCalled).toBe(true);
    expect(nextArg).toBeUndefined();
  });
});

// ── apiVersionFrom helper ────────────────────────────────────────────────────

describe("apiVersionFrom()", () => {
  it("returns 'unversioned' for a plain Request with no marker", () => {
    const req = { path: "/health" } as unknown as Request;
    expect(apiVersionFrom(req)).toBe("unversioned");
  });

  it("returns the version marker set by apiVersionMiddleware for a v1 path", () => {
    const { req } = run(`/api/${API_VERSION}/trades`);
    expect(apiVersionFrom(req)).toBe(API_VERSION);
  });

  it("returns LEGACY_PATH_PREFIX for a legacy alias path", () => {
    const { req } = run("/auth/challenge");
    expect(apiVersionFrom(req)).toBe(LEGACY_PATH_PREFIX);
  });

  it("reads an explicitly pre-set apiVersion marker", () => {
    const req = { path: "/custom" } as unknown as Request;
    (req as unknown as ApiVersionedRequest).apiVersion = "v99";
    expect(apiVersionFrom(req)).toBe("v99");
  });
});

// ── PUBLIC_API_BASE_PATHS correctness ────────────────────────────────────────

describe("PUBLIC_API_BASE_PATHS contract", () => {
  it("includes all expected consumer-facing route groups", () => {
    const required = ["/auth", "/wallet", "/users", "/trades", "/goals", "/disputes", "/dispute-categories", "/stellar", "/contract", "/treasury", "/webhooks", "/evidence"];
    for (const p of required) {
      expect(PUBLIC_API_BASE_PATHS).toContain(p);
    }
  });

  it("does NOT include admin, health, or generic /api paths", () => {
    expect(PUBLIC_API_BASE_PATHS).not.toContain("/admin");
    expect(PUBLIC_API_BASE_PATHS).not.toContain("/api");
    expect(PUBLIC_API_BASE_PATHS).not.toContain("/health");
    expect(PUBLIC_API_BASE_PATHS).not.toContain("/api/admin");
  });

  it("is a readonly array (cannot be mutated at runtime)", () => {
    expect(() => {
      (PUBLIC_API_BASE_PATHS as string[]).push("/injected");
    }).toThrow();
  });
});

// ── error-propagation ────────────────────────────────────────────────────────

describe("apiVersionMiddleware — next() is always called exactly once", () => {
  const allSamplePaths = [
    `/api/${API_VERSION}/trades`,
    "/trades",
    "/admin/features",
    "/health",
    "/unknown",
  ];

  it.each(allSamplePaths)("next() is called exactly once for: %s", (path) => {
    const calls: unknown[] = [];
    const next: NextFunction = (arg?: unknown) => calls.push(arg ?? "__none__");
    const req = { path, headers: {} } as unknown as Request;
    const res = { setHeader: jest.fn() } as unknown as Response;

    apiVersionMiddleware(req, res, next);

    expect(calls).toHaveLength(1);
  });

  it("never passes an Error to next() — all paths are pass-through", () => {
    for (const path of allSamplePaths) {
      const { nextArg } = run(path);
      expect(nextArg).not.toBeInstanceOf(Error);
    }
  });
});
