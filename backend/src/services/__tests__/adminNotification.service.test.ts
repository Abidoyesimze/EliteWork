jest.mock("../../middleware/logger", () => ({
  appLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { appLogger } from "../../middleware/logger";
import {
  AdminNotificationEvents,
  AdminNotificationService,
  extractErrorInfo,
  OperationFailedPayload,
  StreamLockedPayload,
  StreamTerminatedPayload,
  StreamUnlockedPayload,
} from "../adminNotification.service";

const mockLogger = appLogger as unknown as {
  info: jest.Mock;
  error: jest.Mock;
};

function makeLockedPayload(): StreamLockedPayload {
  return {
    streamId: "stream-123",
    adminAddress: "GADMIN",
    reason: "Maintenance",
    timestamp: "2026-07-30T12:00:00.000Z",
  };
}

function makeUnlockedPayload(): StreamUnlockedPayload {
  return {
    streamId: "stream-123",
    adminAddress: "GADMIN",
    reason: null,
    timestamp: "2026-07-30T12:01:00.000Z",
  };
}

function makeTerminatedPayload(): StreamTerminatedPayload {
  return {
    streamId: "stream-123",
    adminAddress: "GADMIN",
    reason: "Fraud investigation",
    previousStatus: "ACTIVE",
    terminatedAt: "2026-07-30T12:02:00.000Z",
    unclaimed: "7500",
  };
}

function makeFailedPayload(): OperationFailedPayload {
  return {
    streamId: "stream-123",
    adminAddress: "GADMIN",
    action: "STREAM_LOCK",
    error: { message: "Stream not found", code: "NOT_FOUND" },
    timestamp: "2026-07-30T12:03:00.000Z",
  };
}

describe("AdminNotificationService", () => {
  let service: AdminNotificationService;

  beforeEach(() => {
    service = new AdminNotificationService();
    jest.clearAllMocks();
  });

  describe("notifications", () => {
    it("emits the stream-locked event with the provided payload", () => {
      const listener = jest.fn();
      const payload = makeLockedPayload();
      service.onSuccess(AdminNotificationEvents.STREAM_LOCKED, listener);

      service.notifyStreamLocked(payload);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);
    });

    it("emits the stream-unlocked event with the provided payload", () => {
      const listener = jest.fn();
      const payload = makeUnlockedPayload();
      service.onSuccess(AdminNotificationEvents.STREAM_UNLOCKED, listener);

      service.notifyStreamUnlocked(payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });

    it("emits the stream-terminated event with the provided payload", () => {
      const listener = jest.fn();
      const payload = makeTerminatedPayload();
      service.onFailure(AdminNotificationEvents.STREAM_TERMINATED, listener);

      service.notifyStreamTerminated(payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });

    it("emits the operation-failed event with the provided payload", () => {
      const listener = jest.fn();
      const payload = makeFailedPayload();
      service.onFailure(AdminNotificationEvents.OPERATION_FAILED, listener);

      service.notifyOperationFailed(payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });

    it("notifies every registered listener", () => {
      const first = jest.fn();
      const second = jest.fn();
      service.onSuccess(AdminNotificationEvents.STREAM_LOCKED, first);
      service.onSuccess(AdminNotificationEvents.STREAM_LOCKED, second);

      service.notifyStreamLocked(makeLockedPayload());

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("does not throw when an event has no listeners beyond the defaults", () => {
      expect(() => service.notifyStreamUnlocked(makeUnlockedPayload())).not.toThrow();
    });

    it("propagates listener errors so callers can fail fast", () => {
      service.onSuccess(AdminNotificationEvents.STREAM_LOCKED, () => {
        throw new Error("listener boom");
      });

      expect(() => service.notifyStreamLocked(makeLockedPayload())).toThrow("listener boom");
    });
  });

  describe("default listeners", () => {
    it("logs stream lock/unlock/termination notifications at info level", () => {
      service.notifyStreamLocked(makeLockedPayload());
      service.notifyStreamUnlocked(makeUnlockedPayload());
      service.notifyStreamTerminated(makeTerminatedPayload());

      expect(mockLogger.info).toHaveBeenCalledTimes(3);
      expect(mockLogger.info).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ event: AdminNotificationEvents.STREAM_LOCKED }),
        "Admin notification: stream locked",
      );
      expect(mockLogger.info).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ event: AdminNotificationEvents.STREAM_UNLOCKED }),
        "Admin notification: stream unlocked",
      );
      expect(mockLogger.info).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ event: AdminNotificationEvents.STREAM_TERMINATED }),
        "Admin notification: stream terminated",
      );
    });

    it("logs operation failures at error level", () => {
      const payload = makeFailedPayload();

      service.notifyOperationFailed(payload);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: AdminNotificationEvents.OPERATION_FAILED }),
        "Admin notification: operation failed",
      );
    });

    it("removes custom listeners but restores the default listeners", () => {
      const listener = jest.fn();
      service.onSuccess(AdminNotificationEvents.STREAM_LOCKED, listener);

      service.removeAllListeners();
      service.notifyStreamLocked(makeLockedPayload());

      expect(listener).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
    });
  });
});

describe("extractErrorInfo", () => {
  it("extracts message, code, and details from an error-like object", () => {
    const result = extractErrorInfo({
      message: "Stream not found",
      code: "NOT_FOUND",
      details: { streamId: "s1" },
    });

    expect(result).toEqual({
      message: "Stream not found",
      code: "NOT_FOUND",
      details: { streamId: "s1" },
    });
  });

  it("extracts the message from an Error instance without optional fields", () => {
    const result = extractErrorInfo(new Error("Something went wrong"));

    expect(result).toEqual({ message: "Something went wrong", code: undefined, details: undefined });
  });

  it("omits non-string codes and non-object details", () => {
    const result = extractErrorInfo({
      message: "bad request",
      code: 400,
      details: "not-an-object",
    });

    expect(result).toEqual({ message: "bad request", code: undefined, details: undefined });
  });

  it("falls back to stringifying objects without a string message", () => {
    expect(extractErrorInfo({ message: 42 })).toEqual({
      message: "[object Object]",
      code: undefined,
      details: undefined,
    });
    expect(extractErrorInfo({ code: "E_FAIL" })).toEqual({
      message: "[object Object]",
      code: "E_FAIL",
      details: undefined,
    });
  });

  it("stringifies primitive errors", () => {
    expect(extractErrorInfo("raw error string").message).toBe("raw error string");
    expect(extractErrorInfo(42).message).toBe("42");
    expect(extractErrorInfo(null).message).toBe("null");
    expect(extractErrorInfo(undefined).message).toBe("undefined");
  });
});
