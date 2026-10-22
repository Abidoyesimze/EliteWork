/**
 * Route-level tests for src/routes/job-health.routes.ts
 *
 * Handlers under test (all mounted at /health/*):
 *   GET  /health/jobs                       — list all job health
 *   GET  /health/jobs/:jobType              — single job health
 *   GET  /health/dashboard                  — analytics dashboard
 *   POST /health/jobs/:jobType/manual-check — manual health check trigger
 *   POST /health/jobs/:jobType/reset-failures — admin failure-count reset
 *
 * Each handler is exercised for:
 *   - Happy path (correct status code + response shape)
 *   - "Validation" failure (unknown jobType → 404)
 *   - Service / DB error (→ 500)
 *
 * Note: the isAdmin middleware in this file is currently a transparent passthrough
 * (next() only), so there is no auth gate to test at the route level.
 */

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long!!";
process.env.JWT_ISSUER = "amana";
process.env.JWT_AUDIENCE = "amana-api";
process.env.DATABASE_URL = "postgresql://localhost:5432/amana_test";
process.env.AMANA_ESCROW_CONTRACT_ID =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
process.env.USDC_CONTRACT_ID =
  "CBIELTK6YBZJU5UP2WWQEUCY7PUJE7R6OB3NIUJKL5UH4WJQJ6HVHKX";

import express from "express";
import request from "supertest";

import { createJobHealthRoutes } from "../routes/job-health.routes";
import { jobHeartbeatService, JobType, type JobHealthStatus } from "../services/jobHeartbeat.service";
import { prisma } from "../lib/db";

// ---------------------------------------------------------------------------
// Module-level mocks — prevent real DB / service calls
// ---------------------------------------------------------------------------
jest.mock("../services/jobHeartbeat.service", () => {
  const actual = jest.requireActual("../services/jobHeartbeat.service");
  return {
    ...actual,
    jobHeartbeatService: {
      getAllJobHealth: jest.fn(),
      getJobHealth: jest.fn(),
    },
  };
});

jest.mock("../lib/db", () => ({
  prisma: {
    jobHeartbeat: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Typed aliases for mocked functions
// ---------------------------------------------------------------------------
const mockGetAllJobHealth = jobHeartbeatService.getAllJobHealth as jest.Mock;
const mockGetJobHealth = jobHeartbeatService.getJobHealth as jest.Mock;
const mockFindMany = (prisma.jobHeartbeat as unknown as { findMany: jest.Mock }).findMany;
const mockUpdate = (prisma.jobHeartbeat as unknown as { update: jest.Mock }).update;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const VALID_JOB_TYPE = JobType.RECONCILIATION; // "reconciliation"
const UNKNOWN_JOB_TYPE = "not-a-real-job";

const NOW = new Date("2026-10-19T10:00:00.000Z");
const NEXT = new Date("2026-10-20T10:00:00.000Z");

function makeHealthStatus(overrides: Partial<JobHealthStatus> = {}): JobHealthStatus {
  return {
    jobType: VALID_JOB_TYPE,
    status: "healthy",
    lastHeartbeat: NOW,
    nextExpectedAt: NEXT,
    timeSinceLastBeat: 60_000,
    failureCount: 0,
    isOverdue: false,
    ...overrides,
  };
}

// Raw DB row shape returned by prisma.jobHeartbeat.findMany
function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    jobType: VALID_JOB_TYPE,
    status: "idle",
    lastHeartbeat: NOW,
    nextExpectedAt: NEXT,
    failureCount: 0,
    intervalMs: 86_400_000,
    lastError: null,
    notes: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/health", createJobHealthRoutes());
  return app;
}

// ===========================================================================
// GET /health/jobs
// ===========================================================================
describe("GET /health/jobs", () => {
  afterEach(() => jest.clearAllMocks());

  describe("happy path — all healthy", () => {
    it("returns 200 when no jobs are overdue", async () => {
      mockGetAllJobHealth.mockResolvedValue([makeHealthStatus()]);

      const res = await request(buildApp()).get("/health/jobs");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
    });

    it("response contains summary, jobs, and timestamp fields", async () => {
      mockGetAllJobHealth.mockResolvedValue([makeHealthStatus()]);

      const res = await request(buildApp()).get("/health/jobs");

      expect(res.body).toHaveProperty("summary");
      expect(res.body).toHaveProperty("jobs");
      expect(res.body).toHaveProperty("timestamp");
    });

    it("summary counts are correct for all-healthy result", async () => {
      mockGetAllJobHealth.mockResolvedValue([
        makeHealthStatus(),
        makeHealthStatus({ jobType: JobType.WEBHOOK }),
      ]);

      const res = await request(buildApp()).get("/health/jobs");

      expect(res.body.summary).toMatchObject({
        total: 2,
        healthy: 2,
        stale: 0,
        overdue: 0,
      });
    });

    it("healthy jobs are listed with required fields", async () => {
      mockGetAllJobHealth.mockResolvedValue([makeHealthStatus()]);

      const res = await request(buildApp()).get("/health/jobs");

      const job = res.body.jobs.healthy[0];
      expect(job).toHaveProperty("jobType");
      expect(job).toHaveProperty("lastHeartbeat");
      expect(job).toHaveProperty("nextExpectedAt");
      expect(job).toHaveProperty("timeSinceLastBeat");
    });
  });

  describe("happy path — degraded (overdue jobs present)", () => {
    it("returns 503 when at least one job is overdue", async () => {
      mockGetAllJobHealth.mockResolvedValue([
        makeHealthStatus({ status: "failed", isOverdue: true }),
      ]);

      const res = await request(buildApp()).get("/health/jobs");

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
    });

    it("returns 503 when a job has isOverdue=true even if status is stale", async () => {
      mockGetAllJobHealth.mockResolvedValue([
        makeHealthStatus({ status: "stale", isOverdue: true }),
      ]);

      const res = await request(buildApp()).get("/health/jobs");

      expect(res.status).toBe(503);
    });

    it("overdue jobs appear in the overdue array with alert field", async () => {
      mockGetAllJobHealth.mockResolvedValue([
        makeHealthStatus({ status: "failed", isOverdue: true, failureCount: 3 }),
      ]);

      const res = await request(buildApp()).get("/health/jobs");

      expect(res.body.jobs.overdue).toHaveLength(1);
      expect(res.body.jobs.overdue[0]).toHaveProperty("alert");
      expect(res.body.jobs.overdue[0].failureCount).toBe(3);
    });

    it("stale jobs (not overdue) appear in stale array with warning field", async () => {
      mockGetAllJobHealth.mockResolvedValue([
        makeHealthStatus({ status: "stale", isOverdue: false }),
      ]);

      const res = await request(buildApp()).get("/health/jobs");

      // stale and not overdue → still 200 (no overdue count), stale array populated
      expect(res.status).toBe(200);
      expect(res.body.jobs.stale).toHaveLength(1);
      expect(res.body.jobs.stale[0]).toHaveProperty("warning");
    });

    it("returns 200 with empty jobs arrays when no heartbeats are registered", async () => {
      mockGetAllJobHealth.mockResolvedValue([]);

      const res = await request(buildApp()).get("/health/jobs");

      expect(res.status).toBe(200);
      expect(res.body.summary.total).toBe(0);
    });
  });

  describe("service error", () => {
    it("returns 500 when the service throws", async () => {
      mockGetAllJobHealth.mockRejectedValue(new Error("DB unavailable"));

      const res = await request(buildApp()).get("/health/jobs");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to retrieve job health");
    });
  });
});

// ===========================================================================
// GET /health/jobs/:jobType
// ===========================================================================
describe("GET /health/jobs/:jobType", () => {
  afterEach(() => jest.clearAllMocks());

  describe("happy path — healthy job", () => {
    it("returns 200 for a healthy job", async () => {
      mockGetJobHealth.mockResolvedValue(makeHealthStatus());

      const res = await request(buildApp()).get(
        `/health/jobs/${VALID_JOB_TYPE}`,
      );

      expect(res.status).toBe(200);
    });

    it("response body contains the health status fields", async () => {
      const health = makeHealthStatus();
      mockGetJobHealth.mockResolvedValue(health);

      const res = await request(buildApp()).get(
        `/health/jobs/${VALID_JOB_TYPE}`,
      );

      expect(res.body).toHaveProperty("jobType");
      expect(res.body).toHaveProperty("status");
      expect(res.body).toHaveProperty("failureCount");
      expect(res.body).toHaveProperty("isOverdue");
    });
  });

  describe("happy path — unhealthy job", () => {
    it("returns 503 when the job status is not healthy", async () => {
      mockGetJobHealth.mockResolvedValue(
        makeHealthStatus({ status: "failed" }),
      );

      const res = await request(buildApp()).get(
        `/health/jobs/${VALID_JOB_TYPE}`,
      );

      expect(res.status).toBe(503);
    });

    it("returns 503 for stale status", async () => {
      mockGetJobHealth.mockResolvedValue(
        makeHealthStatus({ status: "stale" }),
      );

      const res = await request(buildApp()).get(
        `/health/jobs/${VALID_JOB_TYPE}`,
      );

      expect(res.status).toBe(503);
    });
  });

  describe("unknown jobType — 404", () => {
    it("returns 404 for a jobType not in the JobType enum", async () => {
      const res = await request(buildApp()).get(
        `/health/jobs/${UNKNOWN_JOB_TYPE}`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Job not found");
      expect(res.body.jobType).toBe(UNKNOWN_JOB_TYPE);
    });

    it("returns 404 when service returns null (no DB row for valid type)", async () => {
      // isJobType passes but service has no record
      mockGetJobHealth.mockResolvedValue(null);

      const res = await request(buildApp()).get(
        `/health/jobs/${VALID_JOB_TYPE}`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Job not found");
    });
  });

  describe("service error", () => {
    it("returns 500 when the service throws", async () => {
      mockGetJobHealth.mockRejectedValue(new Error("timeout"));

      const res = await request(buildApp()).get(
        `/health/jobs/${VALID_JOB_TYPE}`,
      );

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to retrieve job health");
    });
  });
});

// ===========================================================================
// GET /health/dashboard
// ===========================================================================
describe("GET /health/dashboard", () => {
  afterEach(() => jest.clearAllMocks());

  describe("happy path", () => {
    it("returns 200 with analytics and timestamp", async () => {
      mockFindMany.mockResolvedValue([makeDbRow()]);

      const res = await request(buildApp()).get("/health/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("analytics");
      expect(res.body).toHaveProperty("timestamp");
    });

    it("analytics contains totalJobs, health breakdown, and failureStats", async () => {
      mockFindMany.mockResolvedValue([makeDbRow()]);

      const res = await request(buildApp()).get("/health/dashboard");

      const { analytics } = res.body;
      expect(analytics).toHaveProperty("totalJobs");
      expect(analytics).toHaveProperty("health");
      expect(analytics.health).toHaveProperty("healthy");
      expect(analytics.health).toHaveProperty("stale");
      expect(analytics.health).toHaveProperty("failed");
      expect(analytics).toHaveProperty("failureStats");
    });

    it("jobDetails array contains one entry per DB row", async () => {
      mockFindMany.mockResolvedValue([
        makeDbRow(),
        makeDbRow({ jobType: JobType.WEBHOOK }),
      ]);

      const res = await request(buildApp()).get("/health/dashboard");

      expect(res.body.analytics.jobDetails).toHaveLength(2);
    });

    it("each jobDetail entry has required fields", async () => {
      mockFindMany.mockResolvedValue([makeDbRow()]);

      const res = await request(buildApp()).get("/health/dashboard");

      const detail = res.body.analytics.jobDetails[0];
      expect(detail).toHaveProperty("jobType");
      expect(detail).toHaveProperty("status");
      expect(detail).toHaveProperty("lastHeartbeat");
      expect(detail).toHaveProperty("nextExpectedAt");
      expect(detail).toHaveProperty("failureCount");
      expect(detail).toHaveProperty("intervalMs");
    });

    it("returns 200 with zero totals when no heartbeats are registered", async () => {
      mockFindMany.mockResolvedValue([]);

      const res = await request(buildApp()).get("/health/dashboard");

      expect(res.status).toBe(200);
      expect(res.body.analytics.totalJobs).toBe(0);
    });

    it("counts a job with failureCount > 0 as failed in health breakdown", async () => {
      mockFindMany.mockResolvedValue([
        makeDbRow({ failureCount: 2, status: "idle" }),
      ]);

      const res = await request(buildApp()).get("/health/dashboard");

      expect(res.body.analytics.health.failed).toBe(1);
    });

    it("computes averageFailureCount correctly", async () => {
      mockFindMany.mockResolvedValue([
        makeDbRow({ failureCount: 4 }),
        makeDbRow({ jobType: JobType.WEBHOOK, failureCount: 0 }),
      ]);

      const res = await request(buildApp()).get("/health/dashboard");

      expect(res.body.analytics.failureStats.totalFailures).toBe(4);
      expect(res.body.analytics.failureStats.averageFailureCount).toBe(2);
    });
  });

  describe("service error", () => {
    it("returns 500 when prisma.jobHeartbeat.findMany throws", async () => {
      mockFindMany.mockRejectedValue(new Error("connection refused"));

      const res = await request(buildApp()).get("/health/dashboard");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Dashboard generation failed");
    });
  });
});

// ===========================================================================
// POST /health/jobs/:jobType/manual-check
// ===========================================================================
describe("POST /health/jobs/:jobType/manual-check", () => {
  afterEach(() => jest.clearAllMocks());

  describe("happy path", () => {
    it("returns 200 with message and health fields", async () => {
      mockGetJobHealth.mockResolvedValue(makeHealthStatus());

      const res = await request(buildApp()).post(
        `/health/jobs/${VALID_JOB_TYPE}/manual-check`,
      );

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Health check completed");
      expect(res.body).toHaveProperty("health");
    });

    it("health object in response contains status and jobType", async () => {
      mockGetJobHealth.mockResolvedValue(makeHealthStatus());

      const res = await request(buildApp()).post(
        `/health/jobs/${VALID_JOB_TYPE}/manual-check`,
      );

      expect(res.body.health).toHaveProperty("status");
      expect(res.body.health).toHaveProperty("jobType");
    });

    it("calls getJobHealth with the correct jobType", async () => {
      mockGetJobHealth.mockResolvedValue(makeHealthStatus());

      await request(buildApp()).post(
        `/health/jobs/${VALID_JOB_TYPE}/manual-check`,
      );

      expect(mockGetJobHealth).toHaveBeenCalledWith(VALID_JOB_TYPE);
    });
  });

  describe("unknown jobType — 404", () => {
    it("returns 404 for an unrecognised jobType param", async () => {
      const res = await request(buildApp()).post(
        `/health/jobs/${UNKNOWN_JOB_TYPE}/manual-check`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Job not found");
    });

    it("returns 404 when service returns null for a valid-enum jobType", async () => {
      mockGetJobHealth.mockResolvedValue(null);

      const res = await request(buildApp()).post(
        `/health/jobs/${VALID_JOB_TYPE}/manual-check`,
      );

      expect(res.status).toBe(404);
    });
  });

  describe("service error", () => {
    it("returns 500 when the service throws", async () => {
      mockGetJobHealth.mockRejectedValue(new Error("unexpected failure"));

      const res = await request(buildApp()).post(
        `/health/jobs/${VALID_JOB_TYPE}/manual-check`,
      );

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Manual check failed");
    });
  });
});

// ===========================================================================
// POST /health/jobs/:jobType/reset-failures
// ===========================================================================
describe("POST /health/jobs/:jobType/reset-failures", () => {
  afterEach(() => jest.clearAllMocks());

  describe("happy path", () => {
    it("returns 200 with confirmation message and jobType", async () => {
      mockUpdate.mockResolvedValue({});

      const res = await request(buildApp())
        .post(`/health/jobs/${VALID_JOB_TYPE}/reset-failures`)
        .send({ reason: "Manual operator reset after incident" });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Failure count reset");
      expect(res.body.jobType).toBe(VALID_JOB_TYPE);
    });

    it("calls prisma.jobHeartbeat.update with failureCount 0 and idle status", async () => {
      mockUpdate.mockResolvedValue({});

      await request(buildApp())
        .post(`/health/jobs/${VALID_JOB_TYPE}/reset-failures`)
        .send({ reason: "test reset" });

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { jobType: VALID_JOB_TYPE },
          data: expect.objectContaining({
            failureCount: 0,
            status: "idle",
          }),
        }),
      );
    });

    it("uses the provided reason in the notes field", async () => {
      mockUpdate.mockResolvedValue({});
      const reason = "P1 incident resolved — resetting counter";

      await request(buildApp())
        .post(`/health/jobs/${VALID_JOB_TYPE}/reset-failures`)
        .send({ reason });

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ notes: reason }),
        }),
      );
    });

    it("falls back to default notes when reason is not provided", async () => {
      mockUpdate.mockResolvedValue({});

      await request(buildApp())
        .post(`/health/jobs/${VALID_JOB_TYPE}/reset-failures`)
        .send({});

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            notes: "Failure count reset by admin",
          }),
        }),
      );
    });
  });

  describe("unknown jobType — 404", () => {
    it("returns 404 for an unrecognised jobType param", async () => {
      const res = await request(buildApp()).post(
        `/health/jobs/${UNKNOWN_JOB_TYPE}/reset-failures`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Job not found");
      expect(res.body.jobType).toBe(UNKNOWN_JOB_TYPE);
    });
  });

  describe("service error", () => {
    it("returns 500 when prisma.jobHeartbeat.update throws", async () => {
      mockUpdate.mockRejectedValue(new Error("write conflict"));

      const res = await request(buildApp())
        .post(`/health/jobs/${VALID_JOB_TYPE}/reset-failures`)
        .send({ reason: "test" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Reset failed");
    });
  });
});
