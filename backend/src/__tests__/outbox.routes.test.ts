/**
 * Route-level tests for src/routes/outbox.routes.ts
 *
 * Handlers under test (all mounted at /):
 *   GET  /admin/outbox/health   — consistency scan
 *   GET  /admin/outbox/gaps     — gap report (json / csv / markdown)
 *   GET  /admin/outbox/stats    — outbox queue statistics
 *   POST /admin/outbox/replay   — replay a dead-lettered event
 *
 * Each handler is exercised for:
 *   - Happy path (correct status code + response shape)
 *   - Auth failure (no token / non-admin → 403 from adminMiddleware)
 *   - Validation failure (missing required fields → 400)
 *   - Service / DB error (→ 500)
 *
 * Strategy
 * ─────────
 * adminMiddleware is mocked at the module level so we can toggle it between
 * "pass" (admin user attached) and "block" (403) per describe block.
 * The outbox scanner functions and prisma are mocked to avoid any DB I/O.
 */

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long!!";
process.env.JWT_ISSUER = "amana";
process.env.JWT_AUDIENCE = "amana-api";
process.env.DATABASE_URL = "postgresql://localhost:5432/amana_test";
process.env.AMANA_ESCROW_CONTRACT_ID =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
process.env.USDC_CONTRACT_ID =
  "CBIELTK6YBZJU5UP2WWQEUCY7PUJE7R6OB3NIUJKL5UH4WJQJ6HVHKX";

import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock adminMiddleware before the routes module is loaded
// ---------------------------------------------------------------------------
type MiddlewareFn = (req: Request, res: Response, next: NextFunction) => void;

// Start as a passthrough (admin allowed); individual tests override as needed.
let adminMiddlewareImpl: MiddlewareFn = (_req, _res, next) => next();

jest.mock("../middleware/admin.middleware", () => ({
  adminMiddleware: (req: Request, res: Response, next: NextFunction) =>
    adminMiddlewareImpl(req, res, next),
}));

// ---------------------------------------------------------------------------
// Mock outbox scanner functions
// ---------------------------------------------------------------------------
jest.mock("../lib/outbox/outboxScanner", () => ({
  scanOutboxCompleteness: jest.fn(),
  generateOutboxGapReport: jest.fn(),
  exportOutboxGaps: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock prisma (used lazily via require() inside stats and replay handlers)
// ---------------------------------------------------------------------------
const mockCount = jest.fn();
const mockFindFirst = jest.fn();
const mockUpdate = jest.fn();

jest.mock("../lib/db", () => ({
  prisma: {
    chainEventOutbox: {
      count: (...args: unknown[]) => mockCount(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------
import { createOutboxRoutes } from "../routes/outbox.routes";
import {
  scanOutboxCompleteness,
  generateOutboxGapReport,
  exportOutboxGaps,
} from "../lib/outbox/outboxScanner";

const mockScan = scanOutboxCompleteness as jest.Mock;
const mockGapReport = generateOutboxGapReport as jest.Mock;
const mockExport = exportOutboxGaps as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const HEALTHY_REPORT = {
  scanStartTime: new Date("2026-10-19T10:00:00Z"),
  scanEndTime: new Date("2026-10-19T09:00:00Z"),
  totalTradesScanned: 5,
  gapsDetected: [],
  summary: { criticalGaps: 0, warningGaps: 0, infoGaps: 0 },
};

const DEGRADED_REPORT = {
  ...HEALTHY_REPORT,
  gapsDetected: [
    {
      tradeId: "t-1",
      expectedEventType: "TradeFunded",
      lastStateChange: new Date(),
      detectedAt: new Date(),
      severity: "critical",
      context: { currentStatus: "FUNDED", timeSinceChange: 400_000 },
    },
  ],
  summary: { criticalGaps: 1, warningGaps: 0, infoGaps: 0 },
};

const GAP_REPORT_RESULT = {
  gaps: [],
  summary: { totalGaps: 0, byEventType: {}, bySeverity: { critical: 0, warning: 0, info: 0 } },
  recommendations: [],
};

const MOCK_EVENT_ROW = {
  id: 42,
  tradeId: "trade-replay-001",
  status: "DEAD_LETTER",
  createdAt: new Date("2026-10-18T08:00:00Z"),
};

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/", createOutboxRoutes());
  return app;
}

// ===========================================================================
// GET /admin/outbox/health
// ===========================================================================
describe("GET /admin/outbox/health", () => {
  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // Auth failure
  // -------------------------------------------------------------------------
  describe("auth failure", () => {
    it("returns 403 when adminMiddleware blocks the request", async () => {
      adminMiddlewareImpl = (_req, res) =>
        res.status(403).json({ code: "AUTH_ERROR", error: "Forbidden: admin access required" });

      const res = await request(buildApp()).get("/admin/outbox/health");

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/admin access required/i);

      // restore
      adminMiddlewareImpl = (_req, _res, next) => next();
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — healthy
  // -------------------------------------------------------------------------
  describe("happy path — healthy", () => {
    it("returns 200 when no critical gaps are detected", async () => {
      mockScan.mockResolvedValue(HEALTHY_REPORT);

      const res = await request(buildApp()).get("/admin/outbox/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
    });

    it("response contains status, scanTime, summary, gapCount, criticalGapsPresent", async () => {
      mockScan.mockResolvedValue(HEALTHY_REPORT);

      const res = await request(buildApp()).get("/admin/outbox/health");

      expect(res.body).toHaveProperty("status");
      expect(res.body).toHaveProperty("scanTime");
      expect(res.body).toHaveProperty("summary");
      expect(res.body).toHaveProperty("gapCount");
      expect(res.body).toHaveProperty("criticalGapsPresent");
    });

    it("passes the timeWindow query param to scanOutboxCompleteness", async () => {
      mockScan.mockResolvedValue(HEALTHY_REPORT);

      await request(buildApp()).get("/admin/outbox/health?timeWindow=120");

      expect(mockScan).toHaveBeenCalledWith(120);
    });

    it("defaults to timeWindow=60 when param is absent", async () => {
      mockScan.mockResolvedValue(HEALTHY_REPORT);

      await request(buildApp()).get("/admin/outbox/health");

      expect(mockScan).toHaveBeenCalledWith(60);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — degraded (critical gaps present)
  // -------------------------------------------------------------------------
  describe("happy path — degraded", () => {
    it("returns 500 and status=degraded when critical gaps are present", async () => {
      mockScan.mockResolvedValue(DEGRADED_REPORT);

      const res = await request(buildApp()).get("/admin/outbox/health");

      expect(res.status).toBe(500);
      expect(res.body.status).toBe("degraded");
      expect(res.body.criticalGapsPresent).toBe(true);
    });

    it("gapCount reflects the number of detected gaps", async () => {
      mockScan.mockResolvedValue(DEGRADED_REPORT);

      const res = await request(buildApp()).get("/admin/outbox/health");

      expect(res.body.gapCount).toBe(DEGRADED_REPORT.gapsDetected.length);
    });
  });

  // -------------------------------------------------------------------------
  // Service error
  // -------------------------------------------------------------------------
  describe("service error", () => {
    it("returns 500 with error message when scanner throws", async () => {
      mockScan.mockRejectedValue(new Error("DB timeout"));

      const res = await request(buildApp()).get("/admin/outbox/health");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Consistency check failed");
    });
  });
});

// ===========================================================================
// GET /admin/outbox/gaps
// ===========================================================================
describe("GET /admin/outbox/gaps", () => {
  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // Auth failure
  // -------------------------------------------------------------------------
  describe("auth failure", () => {
    it("returns 403 when adminMiddleware blocks the request", async () => {
      adminMiddlewareImpl = (_req, res) =>
        res.status(403).json({ code: "AUTH_ERROR", error: "Forbidden: admin access required" });

      const res = await request(buildApp()).get("/admin/outbox/gaps");

      expect(res.status).toBe(403);

      adminMiddlewareImpl = (_req, _res, next) => next();
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — JSON (default)
  // -------------------------------------------------------------------------
  describe("happy path — JSON format", () => {
    it("returns 200 with JSON report by default", async () => {
      mockGapReport.mockResolvedValue(GAP_REPORT_RESULT);

      const res = await request(buildApp()).get("/admin/outbox/gaps");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("gaps");
      expect(res.body).toHaveProperty("summary");
      expect(res.body).toHaveProperty("recommendations");
    });

    it("returns 200 with JSON format when format=json is explicit", async () => {
      mockGapReport.mockResolvedValue(GAP_REPORT_RESULT);

      const res = await request(buildApp()).get("/admin/outbox/gaps?format=json");

      expect(res.status).toBe(200);
      expect(res.body.gaps).toBeDefined();
    });

    it("calls generateOutboxGapReport with Date objects", async () => {
      mockGapReport.mockResolvedValue(GAP_REPORT_RESULT);

      await request(buildApp()).get(
        "/admin/outbox/gaps?start=2026-10-01T00:00:00Z&end=2026-10-19T00:00:00Z",
      );

      expect(mockGapReport).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — CSV format
  // -------------------------------------------------------------------------
  describe("happy path — CSV format", () => {
    it("returns 200 with text/csv content-type for format=csv", async () => {
      mockGapReport.mockResolvedValue(GAP_REPORT_RESULT);
      mockExport.mockResolvedValue("TradeId,Severity\nt-1,critical\n");

      const res = await request(buildApp()).get("/admin/outbox/gaps?format=csv");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
    });

    it("calls exportOutboxGaps with csv format", async () => {
      mockGapReport.mockResolvedValue(GAP_REPORT_RESULT);
      mockExport.mockResolvedValue("header\n");

      await request(buildApp()).get("/admin/outbox/gaps?format=csv");

      expect(mockExport).toHaveBeenCalledWith(GAP_REPORT_RESULT.gaps, "csv");
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — Markdown format
  // -------------------------------------------------------------------------
  describe("happy path — Markdown format", () => {
    it("returns 200 with text/markdown content-type for format=markdown", async () => {
      mockGapReport.mockResolvedValue(GAP_REPORT_RESULT);
      mockExport.mockResolvedValue("# Outbox Gaps\n");

      const res = await request(buildApp()).get(
        "/admin/outbox/gaps?format=markdown",
      );

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    });
  });

  // -------------------------------------------------------------------------
  // Service error
  // -------------------------------------------------------------------------
  describe("service error", () => {
    it("returns 500 when generateOutboxGapReport throws", async () => {
      mockGapReport.mockRejectedValue(new Error("query failed"));

      const res = await request(buildApp()).get("/admin/outbox/gaps");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Gap report generation failed");
    });
  });
});

// ===========================================================================
// GET /admin/outbox/stats
// ===========================================================================
describe("GET /admin/outbox/stats", () => {
  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // Auth failure
  // -------------------------------------------------------------------------
  describe("auth failure", () => {
    it("returns 403 when adminMiddleware blocks the request", async () => {
      adminMiddlewareImpl = (_req, res) =>
        res.status(403).json({ code: "AUTH_ERROR", error: "Forbidden: admin access required" });

      const res = await request(buildApp()).get("/admin/outbox/stats");

      expect(res.status).toBe(403);

      adminMiddlewareImpl = (_req, _res, next) => next();
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    beforeEach(() => {
      // count() is called 5 times in order: total, PENDING, PROCESSED, DEAD_LETTER, RETRYING
      mockCount
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(10)  // pending
        .mockResolvedValueOnce(80)  // processed
        .mockResolvedValueOnce(5)   // deadLettered
        .mockResolvedValueOnce(5);  // retrying
      mockFindFirst.mockResolvedValue(null); // no oldest pending
    });

    it("returns 200 with outboxStats and timestamp", async () => {
      const res = await request(buildApp()).get("/admin/outbox/stats");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("outboxStats");
      expect(res.body).toHaveProperty("timestamp");
    });

    it("outboxStats contains all required count fields", async () => {
      const res = await request(buildApp()).get("/admin/outbox/stats");

      const { outboxStats } = res.body;
      expect(outboxStats).toHaveProperty("totalEvents");
      expect(outboxStats).toHaveProperty("pendingEvents");
      expect(outboxStats).toHaveProperty("processedEvents");
      expect(outboxStats).toHaveProperty("deadLetteredEvents");
      expect(outboxStats).toHaveProperty("retryingEvents");
      expect(outboxStats).toHaveProperty("oldestPendingAge");
      expect(outboxStats).toHaveProperty("oldestPendingId");
    });

    it("reflects the correct counts from prisma", async () => {
      const res = await request(buildApp()).get("/admin/outbox/stats");

      expect(res.body.outboxStats.totalEvents).toBe(100);
      expect(res.body.outboxStats.pendingEvents).toBe(10);
      expect(res.body.outboxStats.processedEvents).toBe(80);
      expect(res.body.outboxStats.deadLetteredEvents).toBe(5);
      expect(res.body.outboxStats.retryingEvents).toBe(5);
    });

    it("oldestPendingAge is null when there are no pending events", async () => {
      const res = await request(buildApp()).get("/admin/outbox/stats");

      expect(res.body.outboxStats.oldestPendingAge).toBeNull();
      expect(res.body.outboxStats.oldestPendingId).toBeUndefined();
    });

    it("oldestPendingAge is a number (seconds) when an oldest event exists", async () => {
      mockCount
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      mockFindFirst.mockResolvedValue({
        id: 7,
        createdAt: new Date(Date.now() - 90_000), // 90 seconds ago
      });

      const res = await request(buildApp()).get("/admin/outbox/stats");

      expect(typeof res.body.outboxStats.oldestPendingAge).toBe("number");
      expect(res.body.outboxStats.oldestPendingAge).toBeGreaterThanOrEqual(90);
      expect(res.body.outboxStats.oldestPendingId).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // Service error
  // -------------------------------------------------------------------------
  describe("service error", () => {
    it("returns 500 when prisma.count throws", async () => {
      mockCount.mockRejectedValue(new Error("connection lost"));

      const res = await request(buildApp()).get("/admin/outbox/stats");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Stats retrieval failed");
    });
  });
});

// ===========================================================================
// POST /admin/outbox/replay
// ===========================================================================
describe("POST /admin/outbox/replay", () => {
  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // Auth failure
  // -------------------------------------------------------------------------
  describe("auth failure", () => {
    it("returns 403 when adminMiddleware blocks the request", async () => {
      adminMiddlewareImpl = (_req, res) =>
        res.status(403).json({ code: "AUTH_ERROR", error: "Forbidden: admin access required" });

      const res = await request(buildApp())
        .post("/admin/outbox/replay")
        .send({ eventId: "1" });

      expect(res.status).toBe(403);

      adminMiddlewareImpl = (_req, _res, next) => next();
    });
  });

  // -------------------------------------------------------------------------
  // Validation failure
  // -------------------------------------------------------------------------
  describe("validation failure", () => {
    it("returns 400 when neither eventId nor tradeId is provided", async () => {
      const res = await request(buildApp())
        .post("/admin/outbox/replay")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/missing required field/i);
    });

    it("returns 400 when body has unrelated fields but no eventId or tradeId", async () => {
      const res = await request(buildApp())
        .post("/admin/outbox/replay")
        .send({ unrelated: "field" });

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — by eventId
  // -------------------------------------------------------------------------
  describe("happy path — replay by eventId", () => {
    beforeEach(() => {
      mockFindFirst.mockResolvedValue(MOCK_EVENT_ROW);
      mockUpdate.mockResolvedValue({ ...MOCK_EVENT_ROW, status: "PENDING" });
    });

    it("returns 200 with message, eventId, and tradeId", async () => {
      const res = await request(buildApp())
        .post("/admin/outbox/replay")
        .send({ eventId: "42" });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Event queued for replay");
      expect(res.body.eventId).toBe(MOCK_EVENT_ROW.id);
      expect(res.body.tradeId).toBe(MOCK_EVENT_ROW.tradeId);
    });

    it("calls prisma.update to reset the event to PENDING with attempts=0", async () => {
      await request(buildApp())
        .post("/admin/outbox/replay")
        .send({ eventId: "42" });

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: MOCK_EVENT_ROW.id },
          data: expect.objectContaining({
            status: "PENDING",
            attempts: 0,
            lastError: null,
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — by tradeId
  // -------------------------------------------------------------------------
  describe("happy path — replay by tradeId", () => {
    beforeEach(() => {
      mockFindFirst.mockResolvedValue(MOCK_EVENT_ROW);
      mockUpdate.mockResolvedValue({ ...MOCK_EVENT_ROW, status: "PENDING" });
    });

    it("returns 200 when replaying by tradeId", async () => {
      const res = await request(buildApp())
        .post("/admin/outbox/replay")
        .send({ tradeId: "trade-replay-001" });

      expect(res.status).toBe(200);
      expect(res.body.tradeId).toBe(MOCK_EVENT_ROW.tradeId);
    });
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------
  describe("not found", () => {
    it("returns 404 when no event matches the given eventId", async () => {
      mockFindFirst.mockResolvedValue(null);

      const res = await request(buildApp())
        .post("/admin/outbox/replay")
        .send({ eventId: "9999" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Event not found");
    });

    it("returns 404 when no event matches the given tradeId", async () => {
      mockFindFirst.mockResolvedValue(null);

      const res = await request(buildApp())
        .post("/admin/outbox/replay")
        .send({ tradeId: "nonexistent-trade" });

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Service error
  // -------------------------------------------------------------------------
  describe("service error", () => {
    it("returns 500 when prisma.findFirst throws", async () => {
      mockFindFirst.mockRejectedValue(new Error("DB unreachable"));

      const res = await request(buildApp())
        .post("/admin/outbox/replay")
        .send({ eventId: "42" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Event replay failed");
    });

    it("returns 500 when prisma.update throws after finding the event", async () => {
      mockFindFirst.mockResolvedValue(MOCK_EVENT_ROW);
      mockUpdate.mockRejectedValue(new Error("write conflict"));

      const res = await request(buildApp())
        .post("/admin/outbox/replay")
        .send({ eventId: "42" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Event replay failed");
    });
  });
});
