import { PrismaClient, StreamStatus } from "@prisma/client";
import { AdminStreamsService, vestingStateOf } from "../adminStreams.service";

type StreamRecord = {
  streamId: string;
  recipient: string;
  totalVested: string;
  claimed: string;
  unclaimed: string;
  pendingClawback: string;
  status: StreamStatus;
  adminTags: string[];
  createdAt: Date;
  updatedAt: Date;
};

type StreamPrisma = {
  stream: { findMany: jest.Mock; findUnique: jest.Mock };
};

function makeStream(overrides: Partial<StreamRecord> = {}): StreamRecord {
  return {
    streamId: "stream-1",
    recipient: "GRECIPIENT",
    totalVested: "10000",
    claimed: "0",
    unclaimed: "10000",
    pendingClawback: "0",
    status: StreamStatus.ACTIVE,
    adminTags: [],
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    ...overrides,
  };
}

function makeService(mockPrisma: StreamPrisma): AdminStreamsService {
  return new AdminStreamsService(mockPrisma as unknown as Pick<PrismaClient, "stream">);
}

describe("vestingStateOf", () => {
  it("returns not_started when nothing has been claimed", () => {
    expect(vestingStateOf({ claimed: "0", totalVested: "10000" })).toBe("not_started");
  });

  it("treats blank amounts as zero", () => {
    expect(vestingStateOf({ claimed: "", totalVested: "" })).toBe("not_started");
  });

  it("returns vesting for a partial claim", () => {
    expect(vestingStateOf({ claimed: "2500", totalVested: "10000" })).toBe("vesting");
  });

  it("returns fully_vested when claimed equals totalVested", () => {
    expect(vestingStateOf({ claimed: "10000", totalVested: "10000" })).toBe("fully_vested");
  });

  it("returns fully_vested when claimed exceeds totalVested", () => {
    expect(vestingStateOf({ claimed: "12000", totalVested: "10000" })).toBe("fully_vested");
  });

  it("returns vesting when totalVested is zero but a claim exists", () => {
    expect(vestingStateOf({ claimed: "1", totalVested: "0" })).toBe("vesting");
  });

  it("compares amounts as arbitrary-precision integers", () => {
    expect(
      vestingStateOf({ claimed: "9007199254740993", totalVested: "9007199254740992" }),
    ).toBe("fully_vested");
  });

  it("throws when an amount is not a valid integer string", () => {
    expect(() => vestingStateOf({ claimed: "1.5", totalVested: "2" })).toThrow();
    expect(() => vestingStateOf({ claimed: "1", totalVested: "not-a-number" })).toThrow();
  });
});

describe("AdminStreamsService.list", () => {
  let mockPrisma: StreamPrisma;
  let service: AdminStreamsService;

  beforeEach(() => {
    mockPrisma = {
      stream: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    service = makeService(mockPrisma);
  });

  it("maps streams to summaries and computes vestingState", async () => {
    mockPrisma.stream.findMany.mockResolvedValue([
      makeStream({ streamId: "s1", claimed: "10000", totalVested: "10000" }),
    ]);

    const result = await service.list();

    expect(mockPrisma.stream.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: "desc" },
    });
    expect(result.items).toEqual([
      {
        streamId: "s1",
        recipient: "GRECIPIENT",
        status: StreamStatus.ACTIVE,
        vestingState: "fully_vested",
        totalVested: "10000",
        claimed: "10000",
        unclaimed: "10000",
        pendingClawback: "0",
        adminTags: [],
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-02T00:00:00.000Z"),
      },
    ]);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it("returns an empty page with one total page when no streams exist", async () => {
    const result = await service.list();

    expect(result.items).toEqual([]);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  it("filters by status at the database level", async () => {
    await service.list({ status: StreamStatus.SUSPENDED });

    expect(mockPrisma.stream.findMany).toHaveBeenCalledWith({
      where: { status: StreamStatus.SUSPENDED },
      orderBy: { createdAt: "desc" },
    });
  });

  it("filters by adminTag at the database level", async () => {
    await service.list({ adminTag: "high-value" });

    expect(mockPrisma.stream.findMany).toHaveBeenCalledWith({
      where: { adminTags: { has: "high-value" } },
      orderBy: { createdAt: "desc" },
    });
  });

  it("combines status and adminTag filters", async () => {
    await service.list({ status: StreamStatus.ACTIVE, adminTag: "high-value" });

    expect(mockPrisma.stream.findMany).toHaveBeenCalledWith({
      where: { status: StreamStatus.ACTIVE, adminTags: { has: "high-value" } },
      orderBy: { createdAt: "desc" },
    });
  });

  it("filters by derived vestingState in memory", async () => {
    mockPrisma.stream.findMany.mockResolvedValue([
      makeStream({ streamId: "not-started", claimed: "0" }),
      makeStream({ streamId: "vesting", claimed: "2500" }),
      makeStream({ streamId: "fully-vested", claimed: "10000" }),
    ]);

    const result = await service.list({ vestingState: "vesting" });

    expect(result.items.map((item) => item.streamId)).toEqual(["vesting"]);
    expect(result.pagination.total).toBe(1);
  });

  it("returns an empty result when no stream matches the vestingState", async () => {
    mockPrisma.stream.findMany.mockResolvedValue([makeStream({ claimed: "0" })]);

    const result = await service.list({ vestingState: "fully_vested" });

    expect(result.items).toEqual([]);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  it("paginates the filtered result set", async () => {
    mockPrisma.stream.findMany.mockResolvedValue([
      makeStream({ streamId: "s1" }),
      makeStream({ streamId: "s2" }),
      makeStream({ streamId: "s3" }),
    ]);

    const result = await service.list({ page: 2, limit: 2 });

    expect(result.items.map((item) => item.streamId)).toEqual(["s3"]);
    expect(result.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it("returns an empty page beyond the last page", async () => {
    mockPrisma.stream.findMany.mockResolvedValue([makeStream({ streamId: "s1" })]);

    const result = await service.list({ page: 5, limit: 10 });

    expect(result.items).toEqual([]);
    expect(result.pagination).toEqual({ page: 5, limit: 10, total: 1, totalPages: 1 });
  });

  it("caps the limit at 100 and floors fractional pagination values", async () => {
    mockPrisma.stream.findMany.mockResolvedValue(
      Array.from({ length: 150 }, (_, index) => makeStream({ streamId: `s${index}` })),
    );

    const capped = await service.list({ page: 1, limit: 500 });
    expect(capped.pagination.limit).toBe(100);
    expect(capped.items).toHaveLength(100);

    const floored = await service.list({ page: 2.9, limit: 2.9 });
    expect(floored.pagination).toEqual({ page: 2, limit: 2, total: 150, totalPages: 75 });
    expect(floored.items.map((item) => item.streamId)).toEqual(["s2", "s3"]);
  });

  it("defaults invalid or non-finite page and limit values", async () => {
    const result = await service.list({
      page: Number.NaN,
      limit: Number.POSITIVE_INFINITY,
    });

    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  it("defaults zero and negative page and limit values", async () => {
    const result = await service.list({ page: 0, limit: -5 });

    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  it("propagates database failures from findMany", async () => {
    mockPrisma.stream.findMany.mockRejectedValue(new Error("db down"));

    await expect(service.list()).rejects.toThrow("db down");
  });
});

describe("AdminStreamsService.getByStreamId", () => {
  let mockPrisma: StreamPrisma;
  let service: AdminStreamsService;

  beforeEach(() => {
    mockPrisma = {
      stream: {
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    service = makeService(mockPrisma);
  });

  it("returns the raw stream record for a known id", async () => {
    const stream = makeStream({ streamId: "s1" });
    mockPrisma.stream.findUnique.mockResolvedValue(stream);

    const result = await service.getByStreamId("s1");

    expect(mockPrisma.stream.findUnique).toHaveBeenCalledWith({ where: { streamId: "s1" } });
    expect(result).toEqual(stream);
  });

  it("returns null for an unknown id", async () => {
    expect(await service.getByStreamId("missing")).toBeNull();
  });

  it("propagates database failures from findUnique", async () => {
    mockPrisma.stream.findUnique.mockRejectedValue(new Error("lookup failed"));

    await expect(service.getByStreamId("s1")).rejects.toThrow("lookup failed");
  });
});
