import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockQueryRaw = jest.fn();
const mockRedisPing = jest.fn();
const mockRedisConnect = jest.fn();
const mockRedisDisconnect = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    ping: (...args: unknown[]) => mockRedisPing(...args),
    connect: (...args: unknown[]) => mockRedisConnect(...args),
    disconnect: (...args: unknown[]) => mockRedisDisconnect(...args),
  },
}));

import * as healthService from "../health.service";

describe("health.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("checkDatabase", () => {
    it("returns healthy when the database query succeeds", async () => {
      mockQueryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

      const result = await healthService.checkDatabase();

      expect(mockQueryRaw).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: "healthy" });
    });

    it("returns unhealthy when the database query throws", async () => {
      mockQueryRaw.mockRejectedValueOnce(new Error("connection refused"));

      const result = await healthService.checkDatabase();

      expect(result).toMatchObject({ status: "unhealthy" });
      expect(JSON.stringify(result)).toContain("connection refused");
    });
  });

  describe("checkRedis", () => {
    it("returns healthy when redis responds to ping", async () => {
      mockRedisPing.mockResolvedValueOnce("PONG");

      const result = await healthService.checkRedis();

      expect(mockRedisPing).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: "healthy" });
    });

    it("returns unhealthy when redis ping throws", async () => {
      mockRedisPing.mockRejectedValueOnce(new Error("redis down"));

      const result = await healthService.checkRedis();

      expect(result).toMatchObject({ status: "unhealthy" });
      expect(JSON.stringify(result)).toContain("redis down");
    });
  });

  describe("getHealthStatus", () => {
    it("reports healthy overall when all dependencies are healthy", async () => {
      mockQueryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
      mockRedisPing.mockResolvedValueOnce("PONG");

      const result = await healthService.getHealthStatus();

      expect(result).toMatchObject({ status: "healthy" });
    });

    it("reports unhealthy overall when a dependency fails", async () => {
      mockQueryRaw.mockRejectedValueOnce(new Error("db down"));
      mockRedisPing.mockResolvedValueOnce("PONG");

      const result = await healthService.getHealthStatus();

      expect(result).toMatchObject({ status: "unhealthy" });
    });
  });
});
