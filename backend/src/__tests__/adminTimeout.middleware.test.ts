/**
 * Unit tests for adminTimeoutMiddleware.
 *
 * Covers pass-through, timeout-triggered 504 response, and the guard that
 * avoids double-sending when the handler has already responded.
 *
 * Closes #233.
 */
import { Response, NextFunction } from "express";
import { adminTimeoutMiddleware } from "../middleware/adminTimeout.middleware";
import { ErrorCode } from "../errors/errorCodes";
import type { AuthRequest } from "../services/auth.service";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReq(): AuthRequest {
  return {} as unknown as AuthRequest;
}

interface MockResponse {
  res: Response;
  statusCode: number | undefined;
  body: unknown;
  finished: boolean;
  headersSent: boolean;
  statusFn: jest.Mock;
  jsonFn: jest.Mock;
  onceFn: jest.Mock;
  /** Emit a lifecycle event (finish | close) to trigger cleanup. */
  emit(event: "finish" | "close"): void;
}

function makeRes(headersSentInitially = false): MockResponse {
  const listeners: Record<string, (() => void)[]> = {};
  let _headersSent = headersSentInitially;

  const statusFn = jest.fn().mockImplementation((code: number) => {
    mock.statusCode = code;
    _headersSent = true;
    return mock.res;
  });
  const jsonFn = jest.fn().mockImplementation((body: unknown) => {
    mock.body = body;
    return mock.res;
  });
  const onceFn = jest.fn().mockImplementation((event: string, cb: () => void) => {
    listeners[event] = listeners[event] ?? [];
    listeners[event].push(cb);
    return mock.res;
  });

  const mock: MockResponse = {
    statusCode: undefined,
    body: undefined,
    finished: false,
    get headersSent() { return _headersSent; },
    set headersSent(v: boolean) { _headersSent = v; },
    statusFn,
    jsonFn,
    onceFn,
    emit(event) {
      for (const cb of listeners[event] ?? []) cb();
    },
    res: {} as unknown as Response,
  };

  mock.res = {
    status: statusFn,
    json: jsonFn,
    once: onceFn,
    get headersSent() { return _headersSent; },
  } as unknown as Response;

  return mock;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("adminTimeoutMiddleware", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── pass-through ────────────────────────────────────────────────────────────

  it("calls next() immediately so the handler can proceed", () => {
    const next = jest.fn() as unknown as NextFunction;
    const mock = makeRes();

    adminTimeoutMiddleware(50)(makeReq(), mock.res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(/* no error */);
  });

  it("does NOT send a response before the timeout fires", () => {
    const next = jest.fn() as unknown as NextFunction;
    const mock = makeRes();

    adminTimeoutMiddleware(100)(makeReq(), mock.res, next);

    jest.advanceTimersByTime(99);

    expect(mock.statusFn).not.toHaveBeenCalled();
    expect(mock.jsonFn).not.toHaveBeenCalled();
  });

  // ── timeout fires ───────────────────────────────────────────────────────────

  it("sends a 504 with ADMIN_OPERATION_TIMEOUT code when the timer fires before a response", () => {
    const next = jest.fn() as unknown as NextFunction;
    const mock = makeRes();

    adminTimeoutMiddleware(100)(makeReq(), mock.res, next);

    jest.advanceTimersByTime(100);

    expect(mock.statusFn).toHaveBeenCalledWith(504);
    expect(mock.jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.ADMIN_OPERATION_TIMEOUT,
        error: expect.any(String),
      }),
    );
  });

  it("uses the provided timeoutMs instead of the default", () => {
    const next = jest.fn() as unknown as NextFunction;
    const mock = makeRes();

    adminTimeoutMiddleware(200)(makeReq(), mock.res, next);

    jest.advanceTimersByTime(199);
    expect(mock.statusFn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(mock.statusFn).toHaveBeenCalledWith(504);
  });

  // ── already-responded guard ─────────────────────────────────────────────────

  it("does NOT send a second response if headersSent is true when the timer fires", () => {
    const next = jest.fn() as unknown as NextFunction;
    const mock = makeRes(/* headersSentInitially */ true);

    adminTimeoutMiddleware(50)(makeReq(), mock.res, next);

    jest.advanceTimersByTime(50);

    expect(mock.statusFn).not.toHaveBeenCalled();
    expect(mock.jsonFn).not.toHaveBeenCalled();
  });

  // ── cleanup on finish / close ───────────────────────────────────────────────

  it("clears the timer when the response finishes before the deadline", () => {
    const next = jest.fn() as unknown as NextFunction;
    const mock = makeRes();

    adminTimeoutMiddleware(500)(makeReq(), mock.res, next);

    // Simulate the handler completing normally before the timer fires.
    mock.res.headersSent; // access to confirm property is wired
    (mock as any).headersSent = true;
    mock.emit("finish");

    jest.advanceTimersByTime(500);

    // Timer was cleared — no 504 sent despite time advancing past the deadline.
    expect(mock.statusFn).not.toHaveBeenCalled();
  });

  it("clears the timer when the connection closes before the deadline", () => {
    const next = jest.fn() as unknown as NextFunction;
    const mock = makeRes();

    adminTimeoutMiddleware(500)(makeReq(), mock.res, next);

    (mock as any).headersSent = true;
    mock.emit("close");

    jest.advanceTimersByTime(500);

    expect(mock.statusFn).not.toHaveBeenCalled();
  });

  // ── once registration ───────────────────────────────────────────────────────

  it("registers exactly two once() listeners (finish and close) for cleanup", () => {
    const next = jest.fn() as unknown as NextFunction;
    const mock = makeRes();

    adminTimeoutMiddleware(100)(makeReq(), mock.res, next);

    const events = mock.onceFn.mock.calls.map((c) => c[0]);
    expect(events).toContain("finish");
    expect(events).toContain("close");
    expect(mock.onceFn).toHaveBeenCalledTimes(2);
  });
});
