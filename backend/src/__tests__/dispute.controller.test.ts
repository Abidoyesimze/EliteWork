import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import type { NextFunction, Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createDisputeRouter, DisputeController } from "../controllers/dispute.controller";
import { AppError, ErrorCode } from "../errors/errorCodes";
import { errorHandler } from "../middleware/errorHandler";
import type { AuthRequest } from "../services/auth.service";

jest.mock("../services/auth.service", () => ({
  AuthService: {
    validateToken: jest.fn(async (token: string) => {
      const jwt = require("jsonwebtoken");
      return jwt.decode(token);
    }),
    isTokenRevoked: jest.fn().mockResolvedValue(false),
  },
}));

jest.mock("../lib/db", () => ({ prisma: {} }));

jest.mock("../services/dispute.service", () => {
  const mockDisputeService = {
    listMediatorDisputes: jest.fn(),
    transitionDisputeStatus: jest.fn(),
  };
  return {
    DisputeService: jest.fn(() => mockDisputeService),
    __mockDisputeService: mockDisputeService,
  };
});

type DisputeServiceMocks = {
  listMediatorDisputes: jest.Mock;
  transitionDisputeStatus: jest.Mock;
};

const { __mockDisputeService: mockDisputeService } = jest.requireMock<{
  __mockDisputeService: DisputeServiceMocks;
}>("../services/dispute.service");

const MEDIATOR = StellarSdk.Keypair.random().publicKey();

const PAGE = { items: [{ tradeId: "trade-1", status: "OPEN" }], total: 1, page: 1, limit: 20 };

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    query: {},
    params: {},
    body: {},
    user: { walletAddress: MEDIATOR },
    ...overrides,
  } as unknown as AuthRequest;
}

describe("DisputeController", () => {
  let controller: DisputeController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new DisputeController(mockDisputeService as never);
  });

  describe("listMediatorDisputes", () => {
    it("lists disputes for the caller with the requested filters", async () => {
      mockDisputeService.listMediatorDisputes.mockResolvedValue(PAGE);
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      await controller.listMediatorDisputes(
        mockRequest({ query: { status: "OPEN", page: 2, limit: 10 } as never }),
        res,
        next,
      );

      expect(mockDisputeService.listMediatorDisputes).toHaveBeenCalledWith(MEDIATOR, {
        status: "OPEN",
        page: 2,
        limit: 10,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(PAGE);
      expect(next).not.toHaveBeenCalled();
    });

    it("passes undefined filters through when none are given", async () => {
      mockDisputeService.listMediatorDisputes.mockResolvedValue(PAGE);

      await controller.listMediatorDisputes(mockRequest(), mockResponse(), jest.fn());

      expect(mockDisputeService.listMediatorDisputes).toHaveBeenCalledWith(MEDIATOR, {
        status: undefined,
        page: undefined,
        limit: undefined,
      });
    });

    it("trims the caller's wallet address", async () => {
      mockDisputeService.listMediatorDisputes.mockResolvedValue(PAGE);

      await controller.listMediatorDisputes(
        mockRequest({ user: { walletAddress: `  ${MEDIATOR}  ` } as never }),
        mockResponse(),
        jest.fn(),
      );

      expect(mockDisputeService.listMediatorDisputes).toHaveBeenCalledWith(MEDIATOR, expect.anything());
    });

    it.each([
      ["no user", undefined],
      ["a blank wallet address", { walletAddress: "   " }],
    ])("responds 401 for %s without calling the service", async (_label, user) => {
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      await controller.listMediatorDisputes(mockRequest({ user: user as never }), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockDisputeService.listMediatorDisputes).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it("forwards AppErrors from the service, such as a non-mediator caller", async () => {
      const failure = new AppError(ErrorCode.AUTH_ERROR, "Unauthorized: Not a mediator", 403);
      mockDisputeService.listMediatorDisputes.mockRejectedValue(failure);
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      await controller.listMediatorDisputes(mockRequest(), res, next);

      expect(next).toHaveBeenCalledWith(failure);
      expect(res.json).not.toHaveBeenCalled();
    });

    it("forwards unexpected errors from the service", async () => {
      const failure = new Error("database unavailable");
      mockDisputeService.listMediatorDisputes.mockRejectedValue(failure);
      const next: NextFunction = jest.fn();

      await controller.listMediatorDisputes(mockRequest(), mockResponse(), next);

      expect(next).toHaveBeenCalledWith(failure);
    });
  });

  describe("transitionDisputeStatus", () => {
    it("transitions the dispute for the trade in the path", async () => {
      const updated = { tradeId: "trade-1", status: "UNDER_REVIEW" };
      mockDisputeService.transitionDisputeStatus.mockResolvedValue(updated);
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      await controller.transitionDisputeStatus(
        mockRequest({ params: { id: "trade-1" }, body: { status: "UNDER_REVIEW" } }),
        res,
        next,
      );

      expect(mockDisputeService.transitionDisputeStatus).toHaveBeenCalledWith("trade-1", MEDIATOR, "UNDER_REVIEW");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(updated);
      expect(next).not.toHaveBeenCalled();
    });

    it("responds 401 when the caller is not authenticated", async () => {
      const res = mockResponse();

      await controller.transitionDisputeStatus(
        mockRequest({ user: undefined, params: { id: "trade-1" }, body: { status: "RESOLVED" } }),
        res,
        jest.fn(),
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockDisputeService.transitionDisputeStatus).not.toHaveBeenCalled();
    });

    it("forwards AppErrors from the service, such as an invalid transition", async () => {
      const failure = new AppError(ErrorCode.VALIDATION_ERROR, "Invalid status transition", 409);
      mockDisputeService.transitionDisputeStatus.mockRejectedValue(failure);
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      await controller.transitionDisputeStatus(
        mockRequest({ params: { id: "trade-1" }, body: { status: "CLOSED" } }),
        res,
        next,
      );

      expect(next).toHaveBeenCalledWith(failure);
      expect(res.json).not.toHaveBeenCalled();
    });

    it("forwards unexpected errors from the service", async () => {
      const failure = new Error("transaction aborted");
      mockDisputeService.transitionDisputeStatus.mockRejectedValue(failure);
      const next: NextFunction = jest.fn();

      await controller.transitionDisputeStatus(
        mockRequest({ params: { id: "trade-1" }, body: { status: "CLOSED" } }),
        mockResponse(),
        next,
      );

      expect(next).toHaveBeenCalledWith(failure);
    });
  });
});

describe("createDisputeRouter", () => {
  const app = express();
  app.use(express.json());
  app.use("/disputes", createDisputeRouter({} as never));
  app.use(errorHandler);

  let token: string;

  beforeAll(() => {
    process.env.JWT_ISSUER = process.env.JWT_ISSUER || "amana";
    process.env.JWT_AUDIENCE = process.env.JWT_AUDIENCE || "amana-api";
    const now = Math.floor(Date.now() / 1000);
    token = jwt.sign(
      {
        walletAddress: MEDIATOR,
        jti: "dispute-controller-mediator-jti",
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
        nbf: now - 1,
      },
      process.env.JWT_SECRET!,
      { algorithm: "HS256" },
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("defaults to the shared Prisma client when none is given", async () => {
    const { DisputeService } = jest.requireMock<{ DisputeService: jest.Mock }>("../services/dispute.service");
    const { prisma } = jest.requireMock<{ prisma: unknown }>("../lib/db");

    createDisputeRouter();

    expect(DisputeService).toHaveBeenCalledWith(prisma);
  });

  describe("GET /disputes", () => {
    it("requires authentication", async () => {
      const res = await request(app).get("/disputes");

      expect(res.status).toBe(401);
      expect(mockDisputeService.listMediatorDisputes).not.toHaveBeenCalled();
    });

    it("coerces query parameters before calling the service", async () => {
      mockDisputeService.listMediatorDisputes.mockResolvedValue(PAGE);

      const res = await request(app)
        .get("/disputes")
        .query({ status: "UNDER_REVIEW", page: "3", limit: "25" })
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(PAGE);
      expect(mockDisputeService.listMediatorDisputes).toHaveBeenCalledWith(MEDIATOR, {
        status: "UNDER_REVIEW",
        page: 3,
        limit: 25,
      });
    });

    it.each([
      [{ status: "PENDING" }, "status"],
      [{ page: "0" }, "page"],
      [{ limit: "101" }, "limit"],
      [{ limit: "abc" }, "limit"],
    ])("rejects invalid query %o with 400", async (query, field) => {
      const res = await request(app)
        .get("/disputes")
        .query(query)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(res.body.message).toMatch(new RegExp(`^${field}:`));
      expect(mockDisputeService.listMediatorDisputes).not.toHaveBeenCalled();
    });

    it("maps a service AppError to its status code", async () => {
      mockDisputeService.listMediatorDisputes.mockRejectedValue(
        new AppError(ErrorCode.AUTH_ERROR, "Unauthorized: Not a mediator", 403),
      );

      const res = await request(app).get("/disputes").set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.message).toBe("Unauthorized: Not a mediator");
    });
  });

  describe("POST /disputes/:id/transition", () => {
    it("requires authentication", async () => {
      const res = await request(app).post("/disputes/trade-1/transition").send({ status: "RESOLVED" });

      expect(res.status).toBe(401);
      expect(mockDisputeService.transitionDisputeStatus).not.toHaveBeenCalled();
    });

    it("transitions the dispute", async () => {
      mockDisputeService.transitionDisputeStatus.mockResolvedValue({ tradeId: "trade-1", status: "RESOLVED" });

      const res = await request(app)
        .post("/disputes/trade-1/transition")
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "RESOLVED" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tradeId: "trade-1", status: "RESOLVED" });
      expect(mockDisputeService.transitionDisputeStatus).toHaveBeenCalledWith("trade-1", MEDIATOR, "RESOLVED");
    });

    it.each([[{}], [{ status: "OPEN" }], [{ status: "resolved" }]])(
      "rejects body %o with 400",
      async (body) => {
        const res = await request(app)
          .post("/disputes/trade-1/transition")
          .set("Authorization", `Bearer ${token}`)
          .send(body);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
        expect(mockDisputeService.transitionDisputeStatus).not.toHaveBeenCalled();
      },
    );

    it("maps a service AppError to its status code", async () => {
      mockDisputeService.transitionDisputeStatus.mockRejectedValue(
        new AppError(ErrorCode.NOT_FOUND, "Dispute not found", 404),
      );

      const res = await request(app)
        .post("/disputes/trade-404/transition")
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "CLOSED" });

      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Dispute not found");
    });
  });
});
