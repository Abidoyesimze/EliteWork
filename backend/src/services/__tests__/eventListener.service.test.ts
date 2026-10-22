import { EventListenerService } from "../eventListener.service";

jest.mock("../../lib/prisma", () => ({
  prisma: {
    event: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

const mockPrisma = prisma as unknown as {
  event: {
    findMany: jest.Mock;
    update: jest.Mock;
  };
};

const mockLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

describe("EventListenerService", () => {
  let service: EventListenerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EventListenerService();
  });

  describe("processPendingEvents", () => {
    it("returns 0 when there are no pending events", async () => {
      mockPrisma.event.findMany.mockResolvedValue([]);

      const result = await service.processPendingEvents();

      expect(result).toBe(0);
      expect(mockPrisma.event.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.event.update).not.toHaveBeenCalled();
    });

    it("processes each pending event and marks it processed", async () => {
      const events = [
        { id: "evt-1", type: "transfer", payload: { amount: 1 } },
        { id: "evt-2", type: "mint", payload: { amount: 2 } },
      ];
      mockPrisma.event.findMany.mockResolvedValue(events);
      mockPrisma.event.update.mockResolvedValue({});

      const result = await service.processPendingEvents();

      expect(result).toBe(2);
      expect(mockPrisma.event.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.event.update).toHaveBeenCalledWith({
        where: { id: "evt-1" },
        data: expect.objectContaining({ processed: true }),
      });
    });

    it("logs and continues when a single event fails to process", async () => {
      const events = [
        { id: "evt-1", type: "transfer", payload: {} },
        { id: "evt-2", type: "mint", payload: {} },
      ];
      mockPrisma.event.findMany.mockResolvedValue(events);
      mockPrisma.event.update
        .mockRejectedValueOnce(new Error("db write failed"))
        .mockResolvedValueOnce({});

      const result = await service.processPendingEvents();

      expect(result).toBe(1);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("throws when fetching pending events fails", async () => {
      mockPrisma.event.findMany.mockRejectedValue(new Error("db down"));

      await expect(service.processPendingEvents()).rejects.toThrow("db down");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("handleEvent", () => {
    it("marks the event as processed on success", async () => {
      mockPrisma.event.update.mockResolvedValue({});

      await service.handleEvent({ id: "evt-1", type: "transfer", payload: {} });

      expect(mockPrisma.event.update).toHaveBeenCalledWith({
        where: { id: "evt-1" },
        data: expect.objectContaining({ processed: true }),
      });
    });

    it("propagates errors from the database update", async () => {
      mockPrisma.event.update.mockRejectedValue(new Error("update failed"));

      await expect(
        service.handleEvent({ id: "evt-1", type: "transfer", payload: {} })
      ).rejects.toThrow("update failed");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
