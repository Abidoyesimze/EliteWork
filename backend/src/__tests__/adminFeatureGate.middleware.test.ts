/**
 * Unit tests for adminFeatureGate middleware.
 *
 * Covers pass-through, rejection, and error-propagation behaviour directly
 * without spinning up an Express app, mirroring the pattern in
 * adminQuota.middleware.test.ts.
 *
 * Closes #232.
 */
import { Request, Response, NextFunction } from "express";
import { adminFeatureGate } from "../middleware/adminFeatureGate.middleware";
import { AppError, ErrorCode } from "../errors/errorCodes";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReq(path: string): Request {
  return { path } as unknown as Request;
}

function makeRes(): Response {
  return {} as unknown as Response;
}

// ── pass-through (non-admin paths) ───────────────────────────────────────────

describe("adminFeatureGate — non-admin paths always pass through", () => {
  const nonAdminPaths = [
    "/health",
    "/trades",
    "/api/v1/trades",
    "/auth/challenge",
    "/users/me",
    "/dispute-categories",
    "/",
    "/admin-looking-but-not-admin",
  ];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(nonAdminPaths)("calls next() with no error for path: %s", (path) => {
    const next = jest.fn() as unknown as NextFunction;
    adminFeatureGate(makeReq(path), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(/* no error */);
  });
});

// ── admin paths with feature flag DISABLED ───────────────────────────────────

describe("adminFeatureGate — admin paths blocked when ADMIN_ROUTES_ENABLED is falsy", () => {
  const adminPaths = [
    "/admin",
    "/admin/",
    "/admin/features",
    "/admin/auth/claims",
    "/api/admin",
    "/api/admin/",
    "/api/admin/streams",
    "/api/admin/dlq/pending",
  ];

  beforeEach(() => {
    delete process.env.ADMIN_ROUTES_ENABLED;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ADMIN_ROUTES_ENABLED;
  });

  it.each(adminPaths)(
    "calls next(AppError NOT_FOUND) when ADMIN_ROUTES_ENABLED is unset, path: %s",
    (path) => {
      const next = jest.fn() as unknown as NextFunction;
      adminFeatureGate(makeReq(path), makeRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = (next as jest.Mock).mock.calls[0][0];
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(ErrorCode.NOT_FOUND);
      expect((err as AppError).statusCode).toBe(404);
      expect((err as AppError).message).toMatch(/admin routes are not enabled/i);
    },
  );

  it("calls next(AppError NOT_FOUND) when ADMIN_ROUTES_ENABLED='false'", () => {
    process.env.ADMIN_ROUTES_ENABLED = "false";
    const next = jest.fn() as unknown as NextFunction;
    adminFeatureGate(makeReq("/admin/features"), makeRes(), next);

    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ── admin paths with feature flag ENABLED ────────────────────────────────────

describe("adminFeatureGate — admin paths pass through when ADMIN_ROUTES_ENABLED='true'", () => {
  const adminPaths = [
    "/admin",
    "/admin/features",
    "/api/admin",
    "/api/admin/streams/stream-1/clawback/preview",
  ];

  beforeEach(() => {
    process.env.ADMIN_ROUTES_ENABLED = "true";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.ADMIN_ROUTES_ENABLED = "true";
  });

  it.each(adminPaths)(
    "calls next() with no error when enabled, path: %s",
    (path) => {
      const next = jest.fn() as unknown as NextFunction;
      adminFeatureGate(makeReq(path), makeRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      expect((next as jest.Mock).mock.calls[0][0]).toBeUndefined();
    },
  );
});

// ── safe default (defence-in-depth) ──────────────────────────────────────────

describe("adminFeatureGate — defaults to disabled (safe state)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ADMIN_ROUTES_ENABLED;
  });

  it("blocks admin routes when the env var is entirely absent", () => {
    delete process.env.ADMIN_ROUTES_ENABLED;
    const next = jest.fn() as unknown as NextFunction;
    adminFeatureGate(makeReq("/api/admin/features"), makeRes(), next);

    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(404);
  });

  it("does NOT block non-admin routes regardless of env state", () => {
    delete process.env.ADMIN_ROUTES_ENABLED;
    const next = jest.fn() as unknown as NextFunction;
    adminFeatureGate(makeReq("/trades"), makeRes(), next);

    expect(next).toHaveBeenCalledWith(/* no error */);
  });
});
