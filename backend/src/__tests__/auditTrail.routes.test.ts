/**
 * Route-level tests for src/routes/auditTrail.routes.ts
 *
 * Covers both handlers:
 *   GET /trades/:id/history
 *   GET /trades/:id/history/verify
 *
 * Each handler is tested for:
 *   - Happy path (200 with correct shape)
 *   - Validation failure (400 missing required query param)
 *   - Auth failure (401 no token / 401 bad token)
 *   - Access denied (403)
 *   - Not found (404)
 *   - Config error (500 from AuditSigningConfigError)
 *   - Unexpected service error (500 generic)
 */

// Must be set before any module that reads env is imported
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

import { createAuditTrailRouter } from "../routes/auditTrail.routes";
import {
  AuditTrailService,
  AuditTrailAccessDeniedError,
  AuditTrailTradeNotFoundError,
  AuditSigningConfigError,
  type TradeEvent,
  type CanonicalAuditPayload,
  type AuditIntegrityMetadata,
} from "../services/auditTrail.service";
import { AuthService } from "../services/auth.service";
import { errorHandler } from "../middleware/errorHandler";

// ---------------------------------------------------------------------------
// Global auth service mocks — prevent real Redis / DB calls in authMiddleware
// ---------------------------------------------------------------------------
jest.spyOn(AuthService, "isTokenRevoked").mockResolvedValue(false);
jest.spyOn(AuthService, "getTokenVersion").mockResolvedValue(0);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const BUYER = "GCBUYER00000000000000000000000000000000000000000000000001";
const STRANGER = "GCSTRANGER000000000000000000000000000000000000000000000001";
const TRADE_ID = "trade-abc-123";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ISSUER = process.env.JWT_ISSUER;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE;

function makeToken(walletAddress: string): string {
  return jwt.sign(
    {
      walletAddress,
      jti: `jti-${walletAddress}-${Math.random()}`,
      nbf: Math.floor(Date.now() / 1000) - 1,
    },
    JWT_SECRET!,
    { algorithm: "HS256", issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
  );
}

const t1 = new Date("2026-01-01T10:00:00.000Z");
const t2 = new Date("2026-01-02T10:00:00.000Z");

const MOCK_EVENTS: TradeEvent[] = [
  { eventType: "CREATED", timestamp: t1, actor: BUYER, metadata: { amountUsdc: "100" } },
  { eventType: "FUNDED", timestamp: t2, actor: BUYER, metadata: {} },
];

const MOCK_PAYLOAD: CanonicalAuditPayload = {
  tradeId: TRADE_ID,
  generatedAt: "2026-01-03T00:00:00.000Z",
  events: [
    { eventType: "CREATED", timestamp: t1.toISOString(), actor: BUYER, metadata: { amountUsdc: "100" } },
    { eventType: "FUNDED", timestamp: t2.toISOString(), actor: BUYER, metadata: {} },
  ],
};

const MOCK_INTEGRITY: AuditIntegrityMetadata = {
  algorithm: "ed25519",
  keyId: "key-1",
  payloadHash: "deadbeef",
  signature: "c2lnbmF0dXJl",
};

// ---------------------------------------------------------------------------
// Test app factory — injects a fresh mock service for each test
// ---------------------------------------------------------------------------
function buildApp(service: Partial<AuditTrailService>) {
  const app = express();
  app.use(express.json());
  app.use("/trades", createAuditTrailRouter(service as AuditTrailService));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helper: build a minimal mock service with sane defaults
// ---------------------------------------------------------------------------
function mockService(overrides: Partial<jest.Mocked<AuditTrailService>> = {}): jest.Mocked<AuditTrailService> {
  return {
    getTradeHistory: jest.fn().mockResolvedValue(MOCK_EVENTS),
    getCanonicalPayload: jest.fn().mockReturnValue(MOCK_PAYLOAD),
    signPayload: jest.fn().mockReturnValue(MOCK_INTEGRITY),
    verifyPayload: jest.fn().mockReturnValue(true),
    logScanReport: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as jest.Mocked<AuditTrailService>;
}

// ===========================================================================
// GET /trades/:id/history
// ===========================================================================
describe("GET /trades/:id/history", () => {
  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // Auth failures
  // -------------------------------------------------------------------------
  describe("auth failure", () => {
    it("returns 401 when Authorization header is absent", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history`);

      expect(res.status).toBe(401);
    });

    it("returns 401 when token is malformed", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history`)
        .set("Authorization", "Bearer not.a.real.jwt");

      expect(res.status).toBe(401);
    });

    it("returns 401 when Bearer scheme is missing", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history`)
        .set("Authorization", makeToken(BUYER)); // no "Bearer " prefix

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — JSON (default)
  // -------------------------------------------------------------------------
  describe("happy path — JSON", () => {
    it("returns 200 with events array and correct format field", async () => {
      const svc = mockService();
      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(200);
      expect(res.body.format).toBe("json");
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(res.body.events).toHaveLength(MOCK_EVENTS.length);
    });

    it("calls the service with the correct tradeId and callerAddress", async () => {
      const svc = mockService();
      await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(svc.getTradeHistory).toHaveBeenCalledWith(TRADE_ID, BUYER);
    });

    it("does not include integrity or canonicalPayload when signed is not set", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.body.integrity).toBeUndefined();
      expect(res.body.canonicalPayload).toBeUndefined();
    });

    it("includes integrity and canonicalPayload when signed=true", async () => {
      const svc = mockService();
      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history?signed=true`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(200);
      expect(res.body.integrity).toEqual(MOCK_INTEGRITY);
      expect(res.body.canonicalPayload).toEqual(MOCK_PAYLOAD);
      expect(svc.signPayload).toHaveBeenCalledWith(MOCK_PAYLOAD);
    });

    it("each event has the required shape fields", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      const event = res.body.events[0];
      expect(event).toHaveProperty("eventType");
      expect(event).toHaveProperty("timestamp");
      expect(event).toHaveProperty("actor");
      expect(event).toHaveProperty("metadata");
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — CSV export
  // -------------------------------------------------------------------------
  describe("happy path — CSV export (?format=csv)", () => {
    it("returns 200 with text/csv content type", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history?format=csv`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
    });

    it("sets Content-Disposition with the correct filename", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history?format=csv`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.headers["content-disposition"]).toContain(
        `trade-${TRADE_ID}-history.csv`,
      );
    });

    it("CSV header row contains all required columns", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history?format=csv`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      const header = res.text.split("\n")[0];
      expect(header).toContain("eventType");
      expect(header).toContain("timestamp");
      expect(header).toContain("actor");
      expect(header).toContain("metadata");
    });

    it("CSV has one data row per event", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history?format=csv`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      const nonEmptyLines = res.text.split("\n").filter((l: string) => l.trim() !== "");
      // +1 for the header row
      expect(nonEmptyLines.length).toBe(MOCK_EVENTS.length + 1);
    });

    it("returns JSON envelope (not plain CSV) when format=csv AND signed=true", async () => {
      const svc = mockService();
      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history?format=csv&signed=true`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(200);
      expect(res.body.format).toBe("csv");
      expect(typeof res.body.csv).toBe("string");
      expect(res.body.integrity).toEqual(MOCK_INTEGRITY);
      expect(res.body.canonicalPayload).toEqual(MOCK_PAYLOAD);
    });
  });

  // -------------------------------------------------------------------------
  // Access denied
  // -------------------------------------------------------------------------
  describe("access denied", () => {
    it("returns 403 when caller is not a party to the trade", async () => {
      const svc = mockService({
        getTradeHistory: jest.fn().mockRejectedValue(new AuditTrailAccessDeniedError()),
      });

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history`)
        .set("Authorization", `Bearer ${makeToken(STRANGER)}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/access denied/i);
    });
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------
  describe("not found", () => {
    it("returns 404 when the trade does not exist", async () => {
      const svc = mockService({
        getTradeHistory: jest.fn().mockRejectedValue(new AuditTrailTradeNotFoundError()),
      });

      const res = await request(buildApp(svc))
        .get(`/trades/nonexistent/history`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // Service / config errors
  // -------------------------------------------------------------------------
  describe("server errors", () => {
    it("returns 500 with config error message when signing config is missing", async () => {
      const svc = mockService({
        signPayload: jest.fn().mockImplementation(() => {
          throw new AuditSigningConfigError("AUDIT_SIGNING_KEY_ID and AUDIT_SIGNING_PRIVATE_KEY_PEM are required");
        }),
      });

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history?signed=true`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/AUDIT_SIGNING/i);
    });

    it("returns 500 for unexpected service errors", async () => {
      const svc = mockService({
        getTradeHistory: jest.fn().mockRejectedValue(new Error("Unexpected DB failure")),
      });

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to retrieve trade history");
    });
  });
});

// ===========================================================================
// GET /trades/:id/history/verify
// ===========================================================================
describe("GET /trades/:id/history/verify", () => {
  const VALID_SIGNATURE = Buffer.from("fakesig").toString("base64");

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // Auth failures
  // -------------------------------------------------------------------------
  describe("auth failure", () => {
    it("returns 401 when Authorization header is absent", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`);

      expect(res.status).toBe(401);
    });

    it("returns 401 when token is malformed", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", "Bearer garbage.token.here");

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Validation failure — missing required query param
  // -------------------------------------------------------------------------
  describe("validation failure", () => {
    it("returns 400 when signature query param is missing", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history/verify`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/missing signature/i);
    });

    it("returns 400 when signature query param is empty string", async () => {
      const res = await request(buildApp(mockService()))
        .get(`/trades/${TRADE_ID}/history/verify?signature=`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      // empty string is falsy — treated as missing
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("returns 200 with valid=true and expected shape when signature is correct", async () => {
      process.env.AUDIT_SIGNING_KEY_ID = "key-1";
      const svc = mockService({ verifyPayload: jest.fn().mockReturnValue(true) });

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.algorithm).toBe("ed25519");
      expect(typeof res.body.payloadHash).toBe("string");
      expect(res.body.payloadHash.length).toBeGreaterThan(0);
    });

    it("returns valid=false when signature does not match", async () => {
      process.env.AUDIT_SIGNING_KEY_ID = "key-1";
      const svc = mockService({ verifyPayload: jest.fn().mockReturnValue(false) });

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });

    it("passes the correct tradeId and callerAddress to getTradeHistory", async () => {
      process.env.AUDIT_SIGNING_KEY_ID = "key-1";
      const svc = mockService();

      await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(svc.getTradeHistory).toHaveBeenCalledWith(TRADE_ID, BUYER);
    });

    it("reflects the keyId from env in the response", async () => {
      process.env.AUDIT_SIGNING_KEY_ID = "my-rotation-key";
      const svc = mockService();

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(200);
      expect(res.body.keyId).toBe("my-rotation-key");
    });

    it("returns keyId as null when AUDIT_SIGNING_KEY_ID is not set", async () => {
      delete process.env.AUDIT_SIGNING_KEY_ID;
      const svc = mockService();

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(200);
      expect(res.body.keyId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Access denied
  // -------------------------------------------------------------------------
  describe("access denied", () => {
    it("returns 403 when caller is not a party to the trade", async () => {
      const svc = mockService({
        getTradeHistory: jest.fn().mockRejectedValue(new AuditTrailAccessDeniedError()),
      });

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", `Bearer ${makeToken(STRANGER)}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/access denied/i);
    });
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------
  describe("not found", () => {
    it("returns 404 when the trade does not exist", async () => {
      const svc = mockService({
        getTradeHistory: jest.fn().mockRejectedValue(new AuditTrailTradeNotFoundError()),
      });

      const res = await request(buildApp(svc))
        .get(`/trades/nonexistent/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // Config / server errors
  // -------------------------------------------------------------------------
  describe("server errors", () => {
    it("returns 500 with config error message when public key is missing", async () => {
      const svc = mockService({
        verifyPayload: jest.fn().mockImplementation(() => {
          throw new AuditSigningConfigError("AUDIT_SIGNING_PUBLIC_KEY_PEM is required");
        }),
      });

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/AUDIT_SIGNING_PUBLIC_KEY_PEM/i);
    });

    it("returns 500 for unexpected service errors", async () => {
      const svc = mockService({
        getTradeHistory: jest.fn().mockRejectedValue(new Error("Connection reset")),
      });

      const res = await request(buildApp(svc))
        .get(`/trades/${TRADE_ID}/history/verify?signature=${VALID_SIGNATURE}`)
        .set("Authorization", `Bearer ${makeToken(BUYER)}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to verify trade history signature");
    });
  });
});
