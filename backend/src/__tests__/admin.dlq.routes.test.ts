import express from "express";
import request from "supertest";

const mockListDlqEntries = jest.fn();
const mockGetDlqEntry = jest.fn();
const mockReplayDlqEntry = jest.fn();
const mockDeleteDlqEntry = jest.fn();

jest.mock("../services/dlq.service", () => ({
  listDlqEntries: (...args: unknown[]) => mockListDlqEntries(...args),
  getDlqEntry: (...args: unknown[]) => mockGetDlqEntry(...args),
  replayDlqEntry: (...args: unknown[]) => mockReplayDlqEntry(...args),
  deleteDlqEntry: (...args: unknown[]) => mockDeleteDlqEntry(...args),
}));

const mockRequireAdmin = jest.fn();

jest.mock("../middleware/auth.middleware", () => ({
  requireAdmin: (req: any, res: any, next: any) => mockRequireAdmin(req, res, next),
}));

import adminDlqRouter from "../routes/admin.dlq.routes";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin/dlq", adminDlqRouter);
  return app;
}

describe("admin.dlq.routes", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdmin.mockImplementation((_req: any, _res: any, next: any) => next());
    app = buildApp();
  });

  describe("GET /admin/dlq", () => {
    it("returns the list of DLQ entries (happy path)", async () => {
      const entries = [{ id: "1", status: "pending" }];
      mockListDlqEntries.mockResolvedValue(entries);

      const res = await request(app).get("/admin/dlq");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ entries });
      expect(mockListDlqEntries).toHaveBeenCalledTimes(1);
    });

    it("returns 400 on invalid query params (validation failure)", async () => {
      const res = await request(app).get("/admin/dlq").query({ limit: "not-a-number" });

      expect(res.status).toBe(400);
      expect(mockListDlqEntries).not.toHaveBeenCalled();
    });

    it("returns 401 when auth fails", async () => {
      mockRequireAdmin.mockImplementation((_req: any, res: any) =>
        res.status(401).json({ error: "Unauthorized" })
      );

      const res = await request(app).get("/admin/dlq");

      expect(res.status).toBe(401);
      expect(mockListDlqEntries).not.toHaveBeenCalled();
    });
  });

  describe("GET /admin/dlq/:id", () => {
    it("returns a single DLQ entry (happy path)", async () => {
      const entry = { id: "1", status: "pending" };
      mockGetDlqEntry.mockResolvedValue(entry);

      const res = await request(app).get("/admin/dlq/1");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ entry });
      expect(mockGetDlqEntry).toHaveBeenCalledWith("1");
    });

    it("returns 404 when the entry does not exist (validation failure)", async () => {
      mockGetDlqEntry.mockResolvedValue(null);

      const res = await request(app).get("/admin/dlq/missing");

      expect(res.status).toBe(404);
    });

    it("returns 401 when auth fails", async () => {
      mockRequireAdmin.mockImplementation((_req: any, res: any) =>
        res.status(401).json({ error: "Unauthorized" })
      );

      const res = await request(app).get("/admin/dlq/1");

      expect(res.status).toBe(401);
      expect(mockGetDlqEntry).not.toHaveBeenCalled();
    });
  });

  describe("POST /admin/dlq/:id/replay", () => {
    it("replays a DLQ entry (happy path)", async () => {
      const entry = { id: "1", status: "replayed" };
      mockReplayDlqEntry.mockResolvedValue(entry);

      const res = await request(app).post("/admin/dlq/1/replay");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ entry });
      expect(mockReplayDlqEntry).toHaveBeenCalledWith("1");
    });

    it("returns 404 when the entry does not exist (validation failure)", async () => {
      mockReplayDlqEntry.mockResolvedValue(null);

      const res = await request(app).post("/admin/dlq/missing/replay");

      expect(res.status).toBe(404);
    });

    it("returns 401 when auth fails", async () => {
      mockRequireAdmin.mockImplementation((_req: any, res: any) =>
        res.status(401).json({ error: "Unauthorized" })
      );

      const res = await request(app).post("/admin/dlq/1/replay");

      expect(res.status).toBe(401);
      expect(mockReplayDlqEntry).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /admin/dlq/:id", () => {
    it("deletes a DLQ entry (happy path)", async () => {
      mockDeleteDlqEntry.mockResolvedValue(true);

      const res = await request(app).delete("/admin/dlq/1");

      expect(res.status).toBe(204);
      expect(mockDeleteDlqEntry).toHaveBeenCalledWith("1");
    });

    it("returns 404 when the entry does not exist (validation failure)", async () => {
      mockDeleteDlqEntry.mockResolvedValue(false);

      const res = await request(app).delete("/admin/dlq/missing");

      expect(res.status).toBe(404);
    });

    it("returns 401 when auth fails", async () => {
      mockRequireAdmin.mockImplementation((_req: any, res: any) =>
        res.status(401).json({ error: "Unauthorized" })
      );

      const res = await request(app).delete("/admin/dlq/1");

      expect(res.status).toBe(401);
      expect(mockDeleteDlqEntry).not.toHaveBeenCalled();
    });
  });
});
