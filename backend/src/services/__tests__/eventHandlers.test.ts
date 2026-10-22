import { prisma } from "../../lib/prisma";
import { eventHandlers } from "../eventHandlers";

jest.mock("../../lib/prisma", () => ({
  prisma: {
    event: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

const mockedPrisma = prisma as unknown as {
  event: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

describe("eventHandlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createEvent", () => {
    it("creates an event with the provided payload", async () => {
      const payload = { name: "test-event", data: { foo: "bar" } };
      const created = { id: "evt_1", ...payload };
      mockedPrisma.event.create.mockResolvedValue(created);

      const result = await eventHandlers.createEvent(payload as any);

      expect(mockedPrisma.event.create).toHaveBeenCalledWith({ data: payload });
      expect(result).toEqual(created);
    });

    it("propagates errors from prisma", async () => {
      mockedPrisma.event.create.mockRejectedValue(new Error("db down"));

      await expect(
        eventHandlers.createEvent({ name: "x" } as any),
      ).rejects.toThrow("db down");
    });
  });

  describe("getEvent", () => {
    it("returns the event when found", async () => {
      const event = { id: "evt_1", name: "test-event" };
      mockedPrisma.event.findUnique.mockResolvedValue(event);

      const result = await eventHandlers.getEvent("evt_1");

      expect(mockedPrisma.event.findUnique).toHaveBeenCalledWith({
        where: { id: "evt_1" },
      });
      expect(result).toEqual(event);
    });

    it("returns null when the event does not exist", async () => {
      mockedPrisma.event.findUnique.mockResolvedValue(null);

      const result = await eventHandlers.getEvent("missing");

      expect(result).toBeNull();
    });

    it("propagates errors from prisma", async () => {
      mockedPrisma.event.findUnique.mockRejectedValue(new Error("query failed"));

      await expect(eventHandlers.getEvent("evt_1")).rejects.toThrow(
        "query failed",
      );
    });
  });

  describe("updateEvent", () => {
    it("updates the event with the provided data", async () => {
      const data = { name: "updated" };
      const updated = { id: "evt_1", ...data };
      mockedPrisma.event.update.mockResolvedValue(updated);

      const result = await eventHandlers.updateEvent("evt_1", data as any);

      expect(mockedPrisma.event.update).toHaveBeenCalledWith({
        where: { id: "evt_1" },
        data,
      });
      expect(result).toEqual(updated);
    });

    it("propagates errors from prisma", async () => {
      mockedPrisma.event.update.mockRejectedValue(new Error("update failed"));

      await expect(
        eventHandlers.updateEvent("evt_1", { name: "x" } as any),
      ).rejects.toThrow("update failed");
    });
  });
});
