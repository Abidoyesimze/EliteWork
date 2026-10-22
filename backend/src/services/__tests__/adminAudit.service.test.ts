import { PrismaClient } from "@prisma/client";
import { AdminAuditService } from "../adminAudit.service";
import { computeAuditEntryHash } from "../../lib/auditChain";
import { encodeCursor, InvalidCursorError } from "../../lib/cursorPagination";

type AuditRow = {
  id: number;
  action: string;
  actorAddress: string;
  targetReference: string | null;
  note: string | null;
  createdAt: Date;
  hash: string;
  prevHash: string;
};

type AuditPrisma = {
  adminActionAudit: { findMany: jest.Mock; count: jest.Mock };
};

function makeRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 1,
    action: "TREASURY_WITHDRAW",
    actorAddress: "GADMIN",
    targetReference: "GDEST",
    note: "OPS-42",
    createdAt: new Date("2026-07-02T00:00:00.000Z"),
    hash: "",
    prevHash: "",
    ...overrides,
  };
}

function makeChainedRows(): AuditRow[] {
  const first = makeRow({ id: 1 });
  first.hash = computeAuditEntryHash("", first);

  const second = makeRow({
    id: 2,
    action: "STREAM_TERMINATE",
    targetReference: "stream-1",
    createdAt: new Date("2026-07-03T00:00:00.000Z"),
    prevHash: first.hash,
  });
  second.hash = computeAuditEntryHash(first.hash, second);

  return [first, second];
}

function makeService(mockPrisma: AuditPrisma): AdminAuditService {
  return new AdminAuditService(
    mockPrisma as unknown as Pick<PrismaClient, "adminActionAudit">,
  );
}

describe("AdminAuditService.verifyChain", () => {
  let mockPrisma: AuditPrisma;
  let service: AdminAuditService;

  beforeEach(() => {
    mockPrisma = {
      adminActionAudit: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = makeService(mockPrisma);
  });

  it("returns an empty, valid result when there are no audit rows", async () => {
    const result = await service.verifyChain();

    expect(mockPrisma.adminActionAudit.findMany).toHaveBeenCalledWith({
      orderBy: { id: "asc" },
    });
    expect(result).toEqual({
      valid: true,
      entriesChecked: 0,
      brokenAtId: undefined,
      checkpoint: null,
    });
  });

  it("skips legacy rows that were written before hash chaining", async () => {
    mockPrisma.adminActionAudit.findMany.mockResolvedValue([
      makeRow({ id: 1, hash: "", prevHash: "" }),
      makeRow({ id: 2, hash: "", prevHash: "" }),
    ]);

    const result = await service.verifyChain();

    expect(result).toEqual({
      valid: true,
      entriesChecked: 0,
      brokenAtId: undefined,
      checkpoint: null,
    });
  });

  it("accepts a valid multi-entry chain and exposes the latest hash as checkpoint", async () => {
    const rows = makeChainedRows();
    mockPrisma.adminActionAudit.findMany.mockResolvedValue(rows);

    const result = await service.verifyChain();

    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(2);
    expect(result.brokenAtId).toBeUndefined();
    expect(result.checkpoint).toBe(rows[1].hash);
  });

  it("continues verifying chained rows that follow legacy rows", async () => {
    const rows = makeChainedRows();
    mockPrisma.adminActionAudit.findMany.mockResolvedValue([
      makeRow({ id: 0, hash: "", prevHash: "" }),
      rows[0],
      rows[1],
    ]);

    const result = await service.verifyChain();

    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(2);
    expect(result.checkpoint).toBe(rows[1].hash);
  });

  it("detects a tampered prevHash and reports the first broken id", async () => {
    const rows = makeChainedRows();
    rows[1].prevHash = "tampered-prev-hash";
    mockPrisma.adminActionAudit.findMany.mockResolvedValue(rows);

    const result = await service.verifyChain();

    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(2);
    expect(result.entriesChecked).toBe(2);
  });

  it("detects tampered row data even when prevHash is unchanged", async () => {
    const rows = makeChainedRows();
    rows[1].note = "edited-after-write";
    mockPrisma.adminActionAudit.findMany.mockResolvedValue(rows);

    const result = await service.verifyChain();

    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(2);
  });

  it("reports only the first broken entry when several rows are broken", async () => {
    const rows = makeChainedRows();
    rows[0].hash = "broken-first-hash";
    rows[1].prevHash = rows[0].hash;
    rows[1].hash = "broken-second-hash";
    mockPrisma.adminActionAudit.findMany.mockResolvedValue(rows);

    const result = await service.verifyChain();

    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(1);
    expect(result.entriesChecked).toBe(2);
  });

  it("propagates database failures from findMany", async () => {
    mockPrisma.adminActionAudit.findMany.mockRejectedValue(new Error("db down"));

    await expect(service.verifyChain()).rejects.toThrow("db down");
  });
});

describe("AdminAuditService.list", () => {
  let mockPrisma: AuditPrisma;
  let service: AdminAuditService;

  beforeEach(() => {
    mockPrisma = {
      adminActionAudit: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = makeService(mockPrisma);
  });

  it("uses cursor pagination and trims the look-ahead row", async () => {
    mockPrisma.adminActionAudit.findMany.mockResolvedValue([
      makeRow({ id: 3 }),
      makeRow({ id: 2 }),
      makeRow({ id: 1 }),
    ]);

    const result = await service.list({ limit: 2 });

    expect(mockPrisma.adminActionAudit.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    });
    expect(result.items.map((item) => item.id)).toEqual([3, 2]);
    expect(result.pageInfo).toEqual({
      nextCursor: encodeCursor({ id: 2 }),
      hasNextPage: true,
      limit: 2,
    });
    expect(result.pagination).toBeUndefined();
  });

  it("returns no next cursor when the final page is not full", async () => {
    mockPrisma.adminActionAudit.findMany.mockResolvedValue([makeRow({ id: 9 })]);

    const result = await service.list({ limit: 5 });

    expect(result.items).toHaveLength(1);
    expect(result.pageInfo).toEqual({ nextCursor: null, hasNextPage: false, limit: 5 });
  });

  it("rejects a malformed cursor without querying the database", async () => {
    await expect(service.list({ cursor: "not-a-valid-cursor" })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );

    expect(mockPrisma.adminActionAudit.findMany).not.toHaveBeenCalled();
  });

  it("propagates findMany errors in cursor mode", async () => {
    mockPrisma.adminActionAudit.findMany.mockRejectedValue(new Error("find failed"));

    await expect(service.list({ limit: 10 })).rejects.toThrow("find failed");
  });

  it("supports legacy offset pagination with a stable total", async () => {
    mockPrisma.adminActionAudit.findMany.mockResolvedValue([makeRow({ id: 10 })]);
    mockPrisma.adminActionAudit.count.mockResolvedValue(45);

    const result = await service.list({ page: 2, limit: 10 });

    expect(mockPrisma.adminActionAudit.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      skip: 10,
      take: 10,
    });
    expect(result.items).toHaveLength(1);
    expect(result.pagination).toEqual({ page: 2, limit: 10, total: 45, totalPages: 5 });
    expect(result.pageInfo).toEqual({ nextCursor: null, hasNextPage: true, limit: 10 });
  });

  it("normalizes invalid legacy page and limit values", async () => {
    await service.list({ page: Number.NaN, limit: Number.NaN });

    expect(mockPrisma.adminActionAudit.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 20,
    });
  });

  it("caps cursor limits at the maximum and floors fractional values", async () => {
    await service.list({ limit: 500 });
    expect(mockPrisma.adminActionAudit.findMany).toHaveBeenLastCalledWith({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 101,
    });

    await service.list({ limit: 2.9 });
    expect(mockPrisma.adminActionAudit.findMany).toHaveBeenLastCalledWith({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    });
  });

  it("propagates count failures in legacy mode", async () => {
    mockPrisma.adminActionAudit.count.mockRejectedValue(new Error("count failed"));

    await expect(service.list({ page: 1, limit: 10 })).rejects.toThrow("count failed");
    expect(mockPrisma.adminActionAudit.findMany).toHaveBeenCalled();
  });
});
