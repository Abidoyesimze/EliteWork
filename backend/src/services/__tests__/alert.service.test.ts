import crypto from "crypto";
import { AlertService } from "../alert.service";
import { ALERT_REGISTRY } from "../../config/alertRegistry";

jest.mock("../../middleware/logger", () => ({
  appLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { appLogger } from "../../middleware/logger";

const mockLogger = appLogger as unknown as {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
};

describe("AlertService", () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const webhookUrl = "https://alerts.example.com/hook";

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  describe("isConfigured", () => {
    it("returns false when no webhook URL is configured", () => {
      expect(new AlertService(undefined, undefined, 1000).isConfigured()).toBe(false);
    });

    it("returns true when a webhook URL is configured", () => {
      expect(new AlertService(webhookUrl, undefined, 1000).isConfigured()).toBe(true);
    });
  });

  describe("dispatch", () => {
    it("does nothing when the webhook URL is not configured", async () => {
      const service = new AlertService(undefined, undefined, 1000);

      await service.dispatch("db_connection_failure", "Database down");
      await service.dispatch("db_connection_failure", "Database down again");

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("posts a signed payload with routing metadata and a timestamp", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
      const service = new AlertService(webhookUrl, "test-secret", 1000);

      await service.dispatch("redis_connection_failure", "Redis unavailable", {
        responseTime: 42,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(webhookUrl);
      expect(options.method).toBe("POST");

      const body = options.body as string;
      const payload = JSON.parse(body);
      expect(payload).toEqual({
        type: "redis_connection_failure",
        severity: "critical",
        routing: ALERT_REGISTRY.redis_connection_failure.routing,
        runbookUrl: ALERT_REGISTRY.redis_connection_failure.runbookUrl,
        timestamp: "2026-07-30T12:00:00.000Z",
        message: "Redis unavailable",
        details: { responseTime: 42 },
      });
      expect(options.headers["Content-Type"]).toBe("application/json");

      const expectedSignature = crypto
        .createHmac("sha256", "test-secret")
        .update(body)
        .digest("hex");
      expect(options.headers["X-Alert-Signature"]).toBe(expectedSignature);
    });

    it("omits the signature header when no secret is configured", async () => {
      const service = new AlertService(webhookUrl, undefined, 1000);

      await service.dispatch("cache_unavailable", "Cache down");

      const [, options] = fetchMock.mock.calls[0];
      expect(options.headers).not.toHaveProperty("X-Alert-Signature");
    });

    it("defaults details to an empty object", async () => {
      const service = new AlertService(webhookUrl, undefined, 1000);

      await service.dispatch("cache_unavailable", "Cache down");

      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload.details).toEqual({});
    });

    it("suppresses duplicate alerts of the same type during the cooldown", async () => {
      const service = new AlertService(webhookUrl, undefined, 60_000);

      await service.dispatch("cache_unavailable", "Cache down");
      await service.dispatch("cache_unavailable", "Cache down again");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { type: "cache_unavailable" },
        "Alert suppressed by cooldown",
      );
    });

    it("applies cooldowns independently per alert type", async () => {
      const service = new AlertService(webhookUrl, undefined, 60_000);

      await service.dispatch("db_connection_failure", "Database down");
      await service.dispatch("redis_connection_failure", "Redis down");
      await service.dispatch("db_connection_failure", "Database still down");

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("dispatches again once the cooldown has elapsed", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
      const service = new AlertService(webhookUrl, undefined, 1000);

      await service.dispatch("db_connection_failure", "Database down");
      jest.advanceTimersByTime(1000);
      await service.dispatch("db_connection_failure", "Database down again");

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("prefers a per-alert-type dedupe window over the global cooldown", async () => {
      const service = new AlertService(webhookUrl, undefined, 0);

      await service.dispatch("db_connection_failure", "Database down");
      await service.dispatch("db_connection_failure", "Database down again");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await service.dispatch("synthetic_probe_failure", "Probe failed");
      await service.dispatch("synthetic_probe_failure", "Probe failed again");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("logs a warning and does not set the cooldown on a non-OK response", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
      const service = new AlertService(webhookUrl, undefined, 60_000);

      await service.dispatch("db_connection_failure", "Database down");
      await service.dispatch("db_connection_failure", "Database down again");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { type: "db_connection_failure", statusCode: 503 },
        "Alert dispatch returned non-OK status",
      );
    });

    it("logs and swallows network failures without setting the cooldown", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network error"));
      const service = new AlertService(webhookUrl, undefined, 60_000);

      await expect(
        service.dispatch("db_connection_failure", "Database down"),
      ).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: expect.any(Error), type: "db_connection_failure" },
        "Failed to dispatch alert",
      );

      await service.dispatch("db_connection_failure", "Database down again");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("logs successful dispatches and sets the cooldown", async () => {
      const service = new AlertService(webhookUrl, undefined, 60_000);

      await service.dispatch("db_connection_failure", "Database down");
      await service.dispatch("db_connection_failure", "Database down again");

      expect(mockLogger.info).toHaveBeenCalledWith(
        { type: "db_connection_failure" },
        "Alert dispatched successfully",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("resetCooldown", () => {
    it("clears the cooldown for a single alert type", async () => {
      const service = new AlertService(webhookUrl, undefined, 60_000);

      await service.dispatch("db_connection_failure", "Database down");
      await service.dispatch("redis_connection_failure", "Redis down");
      service.resetCooldown("db_connection_failure");

      await service.dispatch("db_connection_failure", "Database down again");
      await service.dispatch("redis_connection_failure", "Redis down again");

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("clears every cooldown when no type is provided", async () => {
      const service = new AlertService(webhookUrl, undefined, 60_000);

      await service.dispatch("db_connection_failure", "Database down");
      await service.dispatch("redis_connection_failure", "Redis down");
      service.resetCooldown();

      await service.dispatch("db_connection_failure", "Database down again");
      await service.dispatch("redis_connection_failure", "Redis down again");

      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});
