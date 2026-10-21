import { PrismaClient } from "@prisma/client";
import { AuditTrailService, AuditTrailAccessDeniedError, AuditTrailTradeNotFoundError } from "../auditTrail.service";
import { getAuditSigningConfig } from "../../config/auditSigning";
import { OutboxConsistencyReport } from "../../lib/outbox/outboxScanner";

type TradeRow = {
  tradeId: string;
  buyerAddress: string;
  sellerAddress: string;
  amountUsdc: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  fundedAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
};

type ManifestRow = {
  tradeId: string;
  vehicleRegistration: string;
  expectedDeliveryAt: Date;
  createdAt: Date;
};

type EvidenceRow = {
  id: string;
  tradeId: string;
  mimeType: string;
  cid: string;
  filename: string;
  uploadedBy: string;
  createdAt: Date;
};

type DisputeRow = {
  tradeId: string;
  initiator: string;
  reason: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
};

type AuditPrisma = {
  trade: { findUnique: jest.Mock };
  deliveryManifest: { findUnique: jest.Mock };
  tradeEvidence: { findMany: jest.Mock };
  dispute: { findUnique: jest.Mock };
  adminActionAudit: { create: jest.Mock };
};

function makeTrade(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    tradeId: "TRD-TEST-001",
    buyerAddress: "GABUYER123456789012345678901234567890123456789012345678901234",
    sellerAddress: "GASELLER123456789012345678901234567890123456789012345678901234",
    amountUsdc: "5000",
    status: "FUNDED",
    createdAt: new Date("2026-01-15T10:00:00.000Z"),
    updatedAt: new Date("2026-01-15T10:00:00.000Z"),
    fundedAt: new Date("2026-01-15T10:00:00.000Z"),
    deliveredAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeManifest(overrides: Partial<ManifestRow> = {}): ManifestRow {
  return {
    tradeId: "TRD-TEST-001",
    vehicleRegistration: "ABC-123-XYZ",
    expectedDeliveryAt: new Date("2026-01-20T10:00:00.000Z"),
    createdAt: new Date("2026-01-16T10:00:00.000Z"),
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: "ev-1",
    tradeId: "TRD-TEST-001",
    mimeType: "video/mp4",
    cid: "QmTestCID123",
    filename: "delivery.mp4",
    uploadedBy: "GABUYER123456789012345678901234567890123456789012345678901234",
    createdAt: new Date("2026-01-17T10:00:00.000Z"),
    ...overrides,
  };
}

function makeDispute(overrides: Partial<DisputeRow> = {}): DisputeRow {
  return {
    tradeId: "TRD-TEST-001",
    initiator: "GABUYER123456789012345678901234567890123456789012345678901234",
    reason: "Goods damaged",
    status: "OPEN",
    createdAt: new Date("2026-01-18T10:00:00.000Z"),
    resolvedAt: null,
    ...overrides,
  };
}

function makeService(mockPrisma: AuditPrisma): AuditTrailService {
  return new AuditTrailService(mockPrisma as unknown as ConstructorParameters<typeof AuditTrailService>[0]);
}

jest.mock("../../config/auditSigning", () => ({
  getAuditSigningConfig: jest.fn(() => ({
    keyId: "test-key-1",
    privateKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEILj3vYYEOxcsM7lGnaN09jMIy0fCCyKEFfeOhyuIAQHr
-----END PRIVATE KEY-----`,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKEvqvn4gXlbOUFkG2QPE3HaYqfzl305K0Ncj2BvyGzA=
-----END PUBLIC KEY-----`,
  })),
}));

jest.mock("../../config/env", () => ({
  env: {
    EVIDENCE_METADATA_RETENTION_DAYS: 30,
    JWT_SECRET: "test-secret",
    ADMIN_STELLAR_PUBKEYS: "GADMIN123456789012345678901234567890123456789012345678901234",
  },
}));

jest.mock("../../lib/accessControl", () => ({
  getAdminAllowlistLowercase: jest.fn(() => new Set(["gadmin123456789012345678901234567890123456789012345678901234"])),
  getMediatorAllowlist: jest.fn(() => new Set(["GAMEDIATOR123456789012345678901234567890123456789012345678901234"])),
}));

jest.mock("../../lib/db", () => ({
  prisma: {},
}));

jest.mock("../../config/token", () => ({
  TOKEN_CONFIG: { symbol: "cNGN" },
}));

describe("AuditTrailService.getTradeHistory", () => {
  let mockPrisma: AuditPrisma;
  let service: AuditTrailService;

  beforeEach(() => {
    mockPrisma = {
      trade: { findUnique: jest.fn() },
      deliveryManifest: { findUnique: jest.fn() },
      tradeEvidence: { findMany: jest.fn() },
      dispute: { findUnique: jest.fn() },
      adminActionAudit: { create: jest.fn() },
    };
    service = makeService(mockPrisma);
  });

  it("throws AuditTrailTradeNotFoundError when trade does not exist", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(null);

    await expect(
      service.getTradeHistory("TRD-NOTFOUND", "GABUYER123456789012345678901234567890123456789012345678901234")
    ).rejects.toThrow(AuditTrailTradeNotFoundError);
  });

  it("throws AuditTrailAccessDeniedError when caller is not a party or admin", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade());
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    await expect(
      service.getTradeHistory("TRD-TEST-001", "GSTRANGER123456789012345678901234567890123456789012345678901234")
    ).rejects.toThrow(AuditTrailAccessDeniedError);
  });

  it("allows buyer to access trade history", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GABUYER123456789012345678901234567890123456789012345678901234"
    );

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].eventType).toBe("CREATED");
    expect(events[1].eventType).toBe("FUNDED");
  });

  it("allows seller to access trade history", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GASELLER123456789012345678901234567890123456789012345678901234"
    );

    expect(events.length).toBeGreaterThan(0);
  });

  it("allows admin to access trade history", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory("TRD-TEST-001", "GADMIN123456789012345678901234567890123456789012345678901234");

    expect(events.length).toBeGreaterThan(0);
  });

  it("allows mediator access when dispute exists", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "DISPUTED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findUnique.mockResolvedValue(makeDispute());

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GAMEDIATOR123456789012345678901234567890123456789012345678901234"
    );

    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.eventType === "DISPUTE_INITIATED")).toBe(true);
  });

  it("returns events in chronological order", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({
      status: "COMPLETED",
      fundedAt: new Date("2026-01-15T10:00:00.000Z"),
      deliveredAt: new Date("2026-01-17T10:00:00.000Z"),
      completedAt: new Date("2026-01-18T10:00:00.000Z"),
    }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(makeManifest({
      createdAt: new Date("2026-01-16T10:00:00.000Z"),
    }));
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([
      makeEvidence({ createdAt: new Date("2026-01-17T09:00:00.000Z") }),
    ]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GABUYER123456789012345678901234567890123456789012345678901234"
    );

    // Check chronological order
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp.getTime()).toBeGreaterThanOrEqual(events[i-1].timestamp.getTime());
    }
  });

  it("includes MANIFEST_SUBMITTED event when manifest exists", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(makeManifest());
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GABUYER123456789012345678901234567890123456789012345678901234"
    );

    expect(events.some(e => e.eventType === "MANIFEST_SUBMITTED")).toBe(true);
  });

  it("masks vehicle registration for non-admin callers", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(makeManifest({ vehicleRegistration: "ABC-123-XYZ" }));
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GABUYER123456789012345678901234567890123456789012345678901234"
    );

    const manifestEvent = events.find(e => e.eventType === "MANIFEST_SUBMITTED");
    expect(manifestEvent?.metadata.vehicleRegistration).toBe("ABC***");
  });

  it("shows full vehicle registration for admin callers", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(makeManifest({ vehicleRegistration: "ABC-123-XYZ" }));
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GADMIN123456789012345678901234567890123456789012345678901234"
    );

    const manifestEvent = events.find(e => e.eventType === "MANIFEST_SUBMITTED");
    expect(manifestEvent?.metadata.vehicleRegistration).toBe("ABC-123-XYZ");
  });

  it("includes VIDEO_SUBMITTED for video evidence", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([
      makeEvidence({ mimeType: "video/mp4", createdAt: new Date("2026-01-17T10:00:00.000Z") }),
    ]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GABUYER123456789012345678901234567890123456789012345678901234"
    );

    expect(events.some(e => e.eventType === "VIDEO_SUBMITTED")).toBe(true);
  });

  it("includes EVIDENCE_SUBMITTED for non-video evidence", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([
      makeEvidence({ mimeType: "image/jpeg", createdAt: new Date("2026-01-17T10:00:00.000Z") }),
    ]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GABUYER123456789012345678901234567890123456789012345678901234"
    );

    expect(events.some(e => e.eventType === "EVIDENCE_SUBMITTED")).toBe(true);
  });

  it("redacts expired evidence metadata for non-admin", async () => {
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([
      makeEvidence({ createdAt: oldDate, mimeType: "video/mp4" }),
    ]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GABUYER123456789012345678901234567890123456789012345678901234"
    );

    const evidenceEvent = events.find(e => e.eventType === "VIDEO_SUBMITTED");
    expect(evidenceEvent?.actor).toBe("redacted");
    expect(evidenceEvent?.metadata.cid).toBe("redacted");
    expect(evidenceEvent?.metadata.retentionExpired).toBe(true);
  });

  it("shows actor for admin even when evidence expired, but metadata is redacted per retention policy", async () => {
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "FUNDED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([
      makeEvidence({ createdAt: oldDate, mimeType: "video/mp4", cid: "QmOldCID", filename: "old.mp4" }),
    ]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GADMIN123456789012345678901234567890123456789012345678901234"
    );

    const evidenceEvent = events.find(e => e.eventType === "VIDEO_SUBMITTED");
    // Actor is visible to admin even when expired
    expect(evidenceEvent?.actor).toBe("GABUYER123456789012345678901234567890123456789012345678901234");
    // But metadata is redacted per retention policy (expired check doesn't consider admin)
    expect(evidenceEvent?.metadata.cid).toBe("redacted");
    expect(evidenceEvent?.metadata.filename).toBe("redacted");
    expect(evidenceEvent?.metadata.retentionExpired).toBe(true);
  });

  it("includes DISPUTE_INITIATED and RESOLVED events when dispute exists", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({ status: "COMPLETED" }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findUnique.mockResolvedValue(makeDispute({
      resolvedAt: new Date("2026-01-19T10:00:00.000Z"),
      status: "RESOLVED",
    }));

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GABUYER123456789012345678901234567890123456789012345678901234"
    );

    expect(events.some(e => e.eventType === "DISPUTE_INITIATED")).toBe(true);
    expect(events.some(e => e.eventType === "RESOLVED")).toBe(true);
  });

  it("includes COMPLETED event when trade is completed", async () => {
    mockPrisma.trade.findUnique.mockResolvedValue(makeTrade({
      status: "COMPLETED",
      completedAt: new Date("2026-01-18T10:00:00.000Z"),
    }));
    mockPrisma.deliveryManifest.findUnique.mockResolvedValue(null);
    mockPrisma.tradeEvidence.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findUnique.mockResolvedValue(null);

    const events = await service.getTradeHistory(
      "TRD-TEST-001",
      "GABUYER123456789012345678901234567890123456789012345678901234"
    );

    expect(events.some(e => e.eventType === "COMPLETED")).toBe(true);
  });
});

describe("AuditTrailService.getCanonicalPayload", () => {
  let service: AuditTrailService;

  beforeEach(() => {
    const mockPrisma: AuditPrisma = {
      trade: { findUnique: jest.fn() },
      deliveryManifest: { findUnique: jest.fn() },
      tradeEvidence: { findMany: jest.fn() },
      dispute: { findUnique: jest.fn() },
      adminActionAudit: { create: jest.fn() },
    };
    service = makeService(mockPrisma);
  });

  it("returns canonical payload with correct structure", () => {
    const events = [
      {
        eventType: "CREATED" as const,
        timestamp: new Date("2026-01-15T10:00:00.000Z"),
        actor: "GABUYER123456789012345678901234567890123456789012345678901234",
        metadata: { amount: "5000" },
      },
    ];

    const payload = service.getCanonicalPayload("TRD-TEST-001", events);

    expect(payload.tradeId).toBe("TRD-TEST-001");
    expect(payload.generatedAt).toBeDefined();
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].eventType).toBe("CREATED");
    expect(payload.events[0].timestamp).toBe("2026-01-15T10:00:00.000Z");
    expect(payload.events[0].actor).toBe("GABUYER123456789012345678901234567890123456789012345678901234");
    expect(payload.events[0].metadata).toEqual({ amount: "5000" });
  });
});

describe("AuditTrailService.signPayload", () => {
  let service: AuditTrailService;

  beforeEach(() => {
    const mockPrisma: AuditPrisma = {
      trade: { findUnique: jest.fn() },
      deliveryManifest: { findUnique: jest.fn() },
      tradeEvidence: { findMany: jest.fn() },
      dispute: { findUnique: jest.fn() },
      adminActionAudit: { create: jest.fn() },
    };
    service = makeService(mockPrisma);
  });

  it("signs payload and returns integrity metadata", () => {
    const payload = {
      tradeId: "TRD-TEST-001",
      generatedAt: new Date().toISOString(),
      events: [{
        eventType: "CREATED" as const,
        timestamp: "2026-01-15T10:00:00.000Z",
        actor: "GABUYER123456789012345678901234567890123456789012345678901234",
        metadata: { amount: "5000" },
      }],
    };

    const signature = service.signPayload(payload);

    expect(signature.algorithm).toBe("ed25519");
    expect(signature.keyId).toBe("test-key-1");
    expect(signature.payloadHash).toBeDefined();
    expect(signature.signature).toBeDefined();
    expect(typeof signature.signature).toBe("string");
  });

  it("throws when signing config is missing", () => {
    (getAuditSigningConfig as jest.Mock).mockReturnValueOnce({
      keyId: undefined,
      privateKeyPem: undefined,
    });

    const payload = {
      tradeId: "TRD-TEST-001",
      generatedAt: new Date().toISOString(),
      events: [],
    };

    expect(() => service.signPayload(payload)).toThrow("AUDIT_SIGNING_KEY_ID and AUDIT_SIGNING_PRIVATE_KEY_PEM are required");
  });
});

describe("AuditTrailService.verifyPayload", () => {
  let service: AuditTrailService;

  beforeEach(() => {
    const mockPrisma: AuditPrisma = {
      trade: { findUnique: jest.fn() },
      deliveryManifest: { findUnique: jest.fn() },
      tradeEvidence: { findMany: jest.fn() },
      dispute: { findUnique: jest.fn() },
      adminActionAudit: { create: jest.fn() },
    };
    service = makeService(mockPrisma);
  });

  it("verifies a valid signature", () => {
    const payload = {
      tradeId: "TRD-TEST-001",
      generatedAt: new Date().toISOString(),
      events: [{
        eventType: "CREATED" as const,
        timestamp: "2026-01-15T10:00:00.000Z",
        actor: "GABUYER123456789012345678901234567890123456789012345678901234",
        metadata: { amount: "5000" },
      }],
    };

    const signature = service.signPayload(payload);
    const valid = service.verifyPayload(payload, signature.signature);

    expect(valid).toBe(true);
  });

  it("rejects tampered payload", () => {
    const payload = {
      tradeId: "TRD-TEST-001",
      generatedAt: new Date().toISOString(),
      events: [{
        eventType: "CREATED" as const,
        timestamp: "2026-01-15T10:00:00.000Z",
        actor: "GABUYER123456789012345678901234567890123456789012345678901234",
        metadata: { amount: "5000" },
      }],
    };

    const signature = service.signPayload(payload);
    
    // Tamper with the payload
    const tamperedPayload = {
      ...payload,
      events: [{
        ...payload.events[0],
        metadata: { amount: "9999" },
      }],
    };

    const valid = service.verifyPayload(tamperedPayload, signature.signature);
    expect(valid).toBe(false);
  });

  it("throws when public key config is missing", () => {
    (getAuditSigningConfig as jest.Mock).mockReturnValueOnce({
      keyId: "test-key-1",
      privateKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGtestprivatetestprivatetestprivatetestprivatetestprivatetest
-----END PRIVATE KEY-----`,
      publicKeyPem: undefined,
    });

    const payload = {
      tradeId: "TRD-TEST-001",
      generatedAt: new Date().toISOString(),
      events: [],
    };

    expect(() => service.verifyPayload(payload, "signature")).toThrow("AUDIT_SIGNING_PUBLIC_KEY_PEM is required");
  });
});

describe("AuditTrailService.logScanReport", () => {
  let mockPrisma: AuditPrisma;
  let service: AuditTrailService;

  beforeEach(() => {
    mockPrisma = {
      trade: { findUnique: jest.fn() },
      deliveryManifest: { findUnique: jest.fn() },
      tradeEvidence: { findMany: jest.fn() },
      dispute: { findUnique: jest.fn() },
      adminActionAudit: { create: jest.fn().mockResolvedValue({}) },
    };
    service = makeService(mockPrisma);
  });

  it("persists outbox scan report to adminActionAudit", async () => {
    const report: OutboxConsistencyReport = {
      scanStartTime: new Date(),
      scanEndTime: new Date(),
      totalTradesScanned: 100,
      gapsDetected: [{ tradeId: "TRD-1", expectedEventType: "TradeFunded", lastStateChange: new Date(), detectedAt: new Date(), severity: "critical", context: { currentStatus: "FUNDED", timeSinceChange: 1000 } }],
      summary: { criticalGaps: 1, warningGaps: 0, infoGaps: 0 },
    };

    await service.logScanReport(report, "job-123");

    expect(mockPrisma.adminActionAudit.create).toHaveBeenCalledWith({
      data: {
        action: "OUTBOX_SCAN_REPORT",
        actorAddress: "system",
        targetReference: "job-123",
        note: expect.stringContaining("totalTradesScanned"),
      },
    });
  });
});