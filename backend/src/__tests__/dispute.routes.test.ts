/**
 * Route-level tests for src/routes/dispute.routes.ts
 *
 * Handlers under test:
 *   GET  /disputes/                    — listMediatorDisputes
 *   POST /disputes/:id/transition      — transitionDisputeStatus
 *
 * Each handler is exercised for:
 *   - Happy path (2xx with correct response shape)
 *   - Validation failure (400 — invalid / missing body or query params)
 *   - Auth failure (401 — no token, malformed token)
 *   - Access denied (403 — non-mediator caller)
 *   - Not found (404 — dispute not found)
 *   - Unexpected service error (500)
 */

// Env vars must be set before any module that reads them at import time
process.env.JWT_SECRET = "test-secret-at-least-32-characters-long!!";
process.env.JWT_ISSUER = "amana";
process.env.JWT_AUDIENCE = "amana-api";
process.env.DATABASE_URL = "postgresql://localhost:5432/amana_test";
process.env.AMANA_ESCROW_CONTRACT_ID =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
process.env.USDC_CONTRACT_ID =
  "CBIELTK6YBZJU5UP2WWQEUCY7PUJE7R6OB3NIUJKL5UH4WJQJ6HVHKX";

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

import { DisputeController, createDisputeRouter } from "../controllers/dispute.controller";
import { DisputeService, type DisputeListResponse, type DisputeResponse } from "../services/dispute.service";
import { AuthService } from "../services/auth.service";
import { AppError, ErrorCode } from "../errors/errorCodes";
import { errorHandler } from "../middleware/errorHandler";

// ---------------------------------------------------------------------------
// Prevent real Redis / DB calls inside authMiddleware
// ---------------------------------------------------------------------------
jest.spyOn(AuthService, "isTokenRevoked").mockResolvedValue(false);
jest.spyOn(AuthService, "getTokenVersion").mockResolvedValue(0);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MEDIATOR = "GCMEDIATOR0000000000000000000000000000000000000000000001";
const NON_MEDIATOR = "GCUSER00000000000000000000000000000000000000000000000001";
const TRADE_ID = "trade-dispute-001";

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_ISSUER = process.env.JWT_ISSUER!;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE!;

function makeToken(walletAddress: string): string {
  return jwt.sign(
    {
      walletAddress,
      jti: `jti-${walletAddress}-${Math.random()}`,
      nbf: Math.floor(Date.now() / 1000) - 1,
    },
    JWT_SECRET,
    { algorithm: "HS256", issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
  );
}

// ---------------------------------------------------------------------------
// Shared mock dispute fixture
// ---------------------------------------------------------------------------
const MOCK_DISPUTE: DisputeResponse = {
  id: 1,
  tradeId: TRADE_ID,
  initiator: NON_MEDIATOR,
  reason: "Goods not delivered",
  status: "OPEN",
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-01T10:00:00.000Z",
  resolvedAt: null,
  trade: {
    buyerAddress: NON_MEDIATOR,
    sellerAddress: "GCSELLER0000000000000000000000000000000000000000000000001",
    amountUsdc: "500",
  },
};

const MOCK_LIST_RESPONSE: DisputeListResponse = {
  items: [MOCK_DISPUTE],
  pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
};

// ---------------------------------------------------------------------------
// Test app factory — injects a fresh mock Prisma so the service never hits DB
// ---------------------------------------------------------------------------
function buildApp(serviceOverrides: Partial<jest.Mocked<DisputeService>> = {}) {
  // Build a mock Prisma client; the controller factory accepts a prisma instance
  // but we bypass DB entirely by mocking the service methods via the controller.
  const mockPrisma = {} as never;
  const app = express();
  app.use(express.json());

  // We inject mock behaviour by replacing methods on the service instance that
  // createDisputeRouter constructs internally. To do this cleanly, we spy on
  // the DisputeService prototype before constructing the router.
  const listSpy = jest
    .spyOn(DisputeService.prototype, "listMediatorDisputes")
    .mockImplementation(
      serviceOverrides.listMediatorDisputes ??
        ((_addr: string, _params?: unknown) => Promise.resolve(MOCK_LIST_RESPONSE)),
    );
  const transitionSpy = jest
    .spyOn(DisputeService.prototype, "transitionDisputeStatus")
    .mockImplementation(
      serviceOverrides.transitionDisputeStatus ??
        ((_tradeId: string, _addr: string, _status: unknown) =>
          Promise.resolve({ ...MOCK_DISPUTE, status: "UNDER_REVIEW" as const })),
    );

  app.use("/disputes", createDisputeRouter(mockPrisma));
  app.use(errorHandler);

  return { app, listSpy, transitionSpy };
}

// ===========================================================================
// GET /disputes  —  listMediatorDisputes
// ===========================================================================
describe("GET /disputes", () => {
  afterEach(() => jest.restoreAllMocks());

  // -------------------------------------------------------------------------
  // Auth failures
  // -------------------------------------------------------------------------
  describe("auth failure", () => {
    it("returns 401 when Authorization header is absent", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/disputes");
      expect(res.status).toBe(401);
    });

    it("returns 401 for a malformed JWT", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/disputes")
        .set("Authorization", "Bearer not.a.jwt");
      expect(res.status).toBe(401);
    });

    it("returns 401 when Bearer scheme is missing", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/disputes")
        .set("Authorization", makeToken(MEDIATOR)); // raw token, no prefix
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Validation failures — invalid query params
  // -------------------------------------------------------------------------
  describe("validation failure", () => {
    it("returns 400 when status is not a valid enum value", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/disputes?status=INVALID_STATUS")
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it("returns 400 when page is not a number", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/disputes?page=abc")
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);
      expect(res.status).toBe(400);
    });

    it("returns 400 when limit exceeds 100", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/disputes?limit=101")
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);
      expect(res.status).toBe(400);
    });

    it("returns 400 when page is less than 1", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/disputes?page=0")
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Access denied
  // -------------------------------------------------------------------------
  describe("access denied", () => {
    it("returns 403 when caller is not in the mediator allowlist", async () => {
      const { app } = buildApp({
        listMediatorDisputes: jest.fn().mockRejectedValue(
          new AppError(ErrorCode.AUTH_ERROR, "Unauthorized: Not a mediator", 403),
        ),
      });

      const res = await request(app)
        .get("/disputes")
        .set("Authorization", `Bearer ${makeToken(NON_MEDIATOR)}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCode.AUTH_ERROR);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("returns 200 with items array and pagination", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/disputes")
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.pagination).toMatchObject({
        page: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
      });
    });

    it("each item has the expected dispute shape", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/disputes")
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);

      const item = res.body.items[0];
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("tradeId");
      expect(item).toHaveProperty("initiator");
      expect(item).toHaveProperty("reason");
      expect(item).toHaveProperty("status");
      expect(item).toHaveProperty("createdAt");
      expect(item).toHaveProperty("trade");
    });

    it("passes status filter to the service when provided", async () => {
      const { app, listSpy } = buildApp();
      await request(app)
        .get("/disputes?status=OPEN")
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);

      expect(listSpy).toHaveBeenCalledWith(
        MEDIATOR,
        expect.objectContaining({ status: "OPEN" }),
      );
    });

    it("passes page and limit to the service when provided", async () => {
      const { app, listSpy } = buildApp();
      await request(app)
        .get("/disputes?page=2&limit=5")
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);

      expect(listSpy).toHaveBeenCalledWith(
        MEDIATOR,
        expect.objectContaining({ page: 2, limit: 5 }),
      );
    });

    it("returns 200 with all valid status filter values", async () => {
      const validStatuses = ["OPEN", "UNDER_REVIEW", "RESOLVED", "CLOSED"];
      for (const status of validStatuses) {
        const { app } = buildApp();
        const res = await request(app)
          .get(`/disputes?status=${status}`)
          .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);
        expect(res.status).toBe(200);
        jest.restoreAllMocks();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Server errors
  // -------------------------------------------------------------------------
  describe("server errors", () => {
    it("returns 500 for unexpected service errors", async () => {
      const { app } = buildApp({
        listMediatorDisputes: jest.fn().mockRejectedValue(new Error("DB pool exhausted")),
      });

      const res = await request(app)
        .get("/disputes")
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`);

      expect(res.status).toBe(500);
    });
  });
});

// ===========================================================================
// POST /disputes/:id/transition  —  transitionDisputeStatus
// ===========================================================================
describe("POST /disputes/:id/transition", () => {
  afterEach(() => jest.restoreAllMocks());

  // -------------------------------------------------------------------------
  // Auth failures
  // -------------------------------------------------------------------------
  describe("auth failure", () => {
    it("returns 401 when Authorization header is absent", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .send({ status: "UNDER_REVIEW" });
      expect(res.status).toBe(401);
    });

    it("returns 401 for a malformed JWT", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", "Bearer garbage.token")
        .send({ status: "UNDER_REVIEW" });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Validation failures — invalid body
  // -------------------------------------------------------------------------
  describe("validation failure", () => {
    it("returns 400 when status field is missing from body", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it("returns 400 when status is not a valid transition value", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({ status: "OPEN" }); // OPEN is not a valid transition target per schema

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it("returns 400 when status is an arbitrary string", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({ status: "INVALID" });

      expect(res.status).toBe(400);
    });

    it("returns 400 when body is not JSON", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .set("Content-Type", "application/json")
        .send("not-json");

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Access denied
  // -------------------------------------------------------------------------
  describe("access denied", () => {
    it("returns 403 when caller is not in the mediator allowlist", async () => {
      const { app } = buildApp({
        transitionDisputeStatus: jest.fn().mockRejectedValue(
          new AppError(ErrorCode.AUTH_ERROR, "Unauthorized: Not a mediator", 403),
        ),
      });

      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(NON_MEDIATOR)}`)
        .send({ status: "UNDER_REVIEW" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCode.AUTH_ERROR);
    });
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------
  describe("not found", () => {
    it("returns 404 when no dispute exists for the given trade", async () => {
      const { app } = buildApp({
        transitionDisputeStatus: jest.fn().mockRejectedValue(
          new AppError(
            ErrorCode.DISPUTE_NOT_FOUND,
            `No dispute found for trade: ${TRADE_ID}`,
            404,
          ),
        ),
      });

      const res = await request(app)
        .post(`/disputes/nonexistent-trade/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({ status: "UNDER_REVIEW" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(ErrorCode.DISPUTE_NOT_FOUND);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("returns 200 with the updated dispute when transition is valid", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({ status: "UNDER_REVIEW" });

      expect(res.status).toBe(200);
      expect(res.body.tradeId).toBe(TRADE_ID);
      expect(res.body.status).toBe("UNDER_REVIEW");
    });

    it("returns the full dispute shape in the response", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({ status: "UNDER_REVIEW" });

      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("tradeId");
      expect(res.body).toHaveProperty("initiator");
      expect(res.body).toHaveProperty("status");
      expect(res.body).toHaveProperty("createdAt");
      expect(res.body).toHaveProperty("trade");
    });

    it("passes tradeId and callerAddress to the service", async () => {
      const { app, transitionSpy } = buildApp();
      await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({ status: "RESOLVED" });

      expect(transitionSpy).toHaveBeenCalledWith(TRADE_ID, MEDIATOR, "RESOLVED");
    });

    it("accepts all valid transition target statuses", async () => {
      const validTargets = ["UNDER_REVIEW", "RESOLVED", "CLOSED"] as const;
      for (const status of validTargets) {
        const { app } = buildApp({
          transitionDisputeStatus: jest.fn().mockResolvedValue({
            ...MOCK_DISPUTE,
            status,
          }),
        });

        const res = await request(app)
          .post(`/disputes/${TRADE_ID}/transition`)
          .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
          .send({ status });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe(status);
        jest.restoreAllMocks();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Domain / conflict errors
  // -------------------------------------------------------------------------
  describe("domain errors", () => {
    it("returns 409 for an invalid status transition", async () => {
      const { app } = buildApp({
        transitionDisputeStatus: jest.fn().mockRejectedValue(
          new AppError(
            ErrorCode.DISPUTE_STATUS_TRANSITION_INVALID,
            "Cannot transition from RESOLVED to UNDER_REVIEW",
            409,
          ),
        ),
      });

      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({ status: "UNDER_REVIEW" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ErrorCode.DISPUTE_STATUS_TRANSITION_INVALID);
    });

    it("returns 409 for a concurrent update conflict", async () => {
      const { app } = buildApp({
        transitionDisputeStatus: jest.fn().mockRejectedValue(
          new AppError(
            ErrorCode.DISPUTE_STATUS_CONFLICT,
            "Dispute was modified concurrently",
            409,
          ),
        ),
      });

      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({ status: "RESOLVED" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ErrorCode.DISPUTE_STATUS_CONFLICT);
    });
  });

  // -------------------------------------------------------------------------
  // Server errors
  // -------------------------------------------------------------------------
  describe("server errors", () => {
    it("returns 500 for unexpected service errors", async () => {
      const { app } = buildApp({
        transitionDisputeStatus: jest.fn().mockRejectedValue(
          new Error("Unexpected DB failure"),
        ),
      });

      const res = await request(app)
        .post(`/disputes/${TRADE_ID}/transition`)
        .set("Authorization", `Bearer ${makeToken(MEDIATOR)}`)
        .send({ status: "UNDER_REVIEW" });

      expect(res.status).toBe(500);
    });
  });
});
