import type { Request, Response } from "express";

// The controller creates its own PrismaClient at import time, so the client is
// mocked at the module boundary and the shared `stream.findUnique` is exposed.
const mockFindUnique = jest.fn();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => ({ stream: { findUnique: mockFindUnique } })),
}));

jest.mock("../services/sorobanAdmin.service", () => ({
  sorobanAdminService: { signTransaction: jest.fn() },
}));

import { executeStreamClawback, getStreamRemaining } from "../controllers/stream.controller";
import { sorobanAdminService } from "../services/sorobanAdmin.service";

const mockSignTransaction = sorobanAdminService.signTransaction as jest.Mock;

const STREAM_ID = "stream-42";

const STREAM = {
  streamId: STREAM_ID,
  totalVested: "1000",
  claimed: "400",
  unclaimed: "600",
  pendingClawback: "0",
};

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockRequest(overrides: { id?: string; body?: Record<string, unknown> } = {}): Request {
  return {
    params: { id: overrides.id ?? STREAM_ID },
    body: overrides.body ?? {},
  } as unknown as Request;
}

describe("StreamController", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  describe("getStreamRemaining", () => {
    it("returns the vesting balances for the stream", async () => {
      mockFindUnique.mockResolvedValue({ ...STREAM, id: 7, createdAt: new Date() });
      const res = mockResponse();

      await getStreamRemaining(mockRequest(), res);

      expect(mockFindUnique).toHaveBeenCalledWith({ where: { streamId: STREAM_ID } });
      expect(res.status).toHaveBeenCalledWith(200);
      // Only the balance fields are exposed, not internal columns.
      expect(res.json).toHaveBeenCalledWith({
        totalVested: "1000",
        claimed: "400",
        unclaimed: "600",
        pendingClawback: "0",
      });
    });

    it("returns 404 when the stream does not exist", async () => {
      mockFindUnique.mockResolvedValue(null);
      const res = mockResponse();

      await getStreamRemaining(mockRequest({ id: "missing" }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "Stream not found" });
    });

    it("returns a generic 500 without leaking the underlying error", async () => {
      mockFindUnique.mockRejectedValue(new Error("connection refused at db.internal:5432"));
      const res = mockResponse();

      await getStreamRemaining(mockRequest(), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe("executeStreamClawback", () => {
    it("signs the provided transaction for a clawback within the unclaimed amount", async () => {
      mockFindUnique.mockResolvedValue(STREAM);
      mockSignTransaction.mockReturnValue("signed-xdr");
      const res = mockResponse();

      await executeStreamClawback(
        mockRequest({ body: { amount: "250", unsignedTxXdr: "unsigned-xdr", reason: "  Terminated contract  " } }),
        res,
      );

      expect(mockSignTransaction).toHaveBeenCalledWith("unsigned-xdr");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: "Clawback transaction prepared/signed",
        signedTxXdr: "signed-xdr",
        reason: "Terminated contract",
      });
    });

    it("allows clawing back exactly the unclaimed amount", async () => {
      mockFindUnique.mockResolvedValue(STREAM);
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ body: { amount: "600" } }), res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("returns a null signed transaction and reason when neither is provided", async () => {
      mockFindUnique.mockResolvedValue(STREAM);
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ body: { amount: "100" } }), res);

      expect(mockSignTransaction).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        message: "Clawback transaction prepared/signed",
        signedTxXdr: null,
        reason: null,
      });
    });

    it("compares amounts as integers, not strings", async () => {
      // "90" > "600" as strings; as BigInts it is well within the unclaimed amount.
      mockFindUnique.mockResolvedValue(STREAM);
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ body: { amount: "90" } }), res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("rejects a missing amount with 400 before touching the database", async () => {
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ body: {} }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Amount is required" });
      expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it("rejects a clawback larger than the unclaimed amount with 400 and does not sign", async () => {
      mockFindUnique.mockResolvedValue(STREAM);
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ body: { amount: "601", unsignedTxXdr: "unsigned-xdr" } }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "Clawback amount exceeds remaining unclaimed vested amount",
      });
      expect(mockSignTransaction).not.toHaveBeenCalled();
    });

    it("returns 404 when the stream does not exist", async () => {
      mockFindUnique.mockResolvedValue(null);
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ id: "missing", body: { amount: "1" } }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "Stream not found" });
    });

    // validateAdminReason throws a 400 AppError, but this controller maps every
    // thrown error to 500. Pinned here as current behaviour; see the PR notes.
    it("rejects an invalid audit reason before looking up the stream (currently as a 500)", async () => {
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ body: { amount: "100", reason: "no" } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Bad Request: Audit reason must be at least 3 characters",
      });
      expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it("reports a non-numeric amount as an error instead of signing", async () => {
      mockFindUnique.mockResolvedValue(STREAM);
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ body: { amount: "ten", unsignedTxXdr: "unsigned-xdr" } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockSignTransaction).not.toHaveBeenCalled();
    });

    it("returns 500 with the error message when signing fails", async () => {
      mockFindUnique.mockResolvedValue(STREAM);
      mockSignTransaction.mockImplementation(() => {
        throw new Error("Invalid transaction XDR");
      });
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ body: { amount: "100", unsignedTxXdr: "garbage" } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid transaction XDR" });
    });

    it("returns a generic 500 when a non-Error is thrown", async () => {
      mockFindUnique.mockRejectedValue("boom");
      const res = mockResponse();

      await executeStreamClawback(mockRequest({ body: { amount: "100" } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });
});
