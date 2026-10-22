import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import { AppError, ErrorCode } from "../errors/errorCodes";
import { errorHandler } from "../middleware/errorHandler";

const mockGetUserReputation = jest.fn();

jest.mock("../services/reputation.service", () => ({
  ReputationService: jest.fn().mockImplementation(() => ({
    getUserReputation: mockGetUserReputation,
  })),
}));

jest.mock("../middleware/auth.middleware", () => ({
  authMiddleware: (req: Request & { user?: { walletAddress: string } }, res: Response, next: NextFunction) => {
    const address = req.header("x-test-user");
    if (!address) return res.status(401).json({ error: "Unauthorized" });
    req.user = { walletAddress: address };
    next();
  },
}));

import reputationRoutes from "../routes/reputation.routes";

const USER = "GUSER";
const REPUTATION = {
  trustScore: 75,
  totalTrades: 6,
  completedTrades: 5,
  disputedTrades: 1,
  successRate: 83.3,
  history: [],
};

function buildApp() {
  const app = express();
  app.use("/users", reputationRoutes);
  app.use(errorHandler);
  return app;
}

describe("reputation routes", () => {
  const app = buildApp();

  beforeEach(() => jest.clearAllMocks());

  describe("GET /users/me/reputation", () => {
    it("returns the authenticated user's reputation", async () => {
      mockGetUserReputation.mockResolvedValue(REPUTATION);

      const response = await request(app)
        .get("/users/me/reputation")
        .set("x-test-user", USER);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(REPUTATION);
      expect(mockGetUserReputation).toHaveBeenCalledWith(USER);
    });

    it("returns 400 when the service rejects the wallet address", async () => {
      mockGetUserReputation.mockRejectedValue(
        new AppError(ErrorCode.VALIDATION_ERROR, "Invalid wallet address", 400),
      );

      const response = await request(app)
        .get("/users/me/reputation")
        .set("x-test-user", USER);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it("returns 401 without authentication", async () => {
      const response = await request(app).get("/users/me/reputation");

      expect(response.status).toBe(401);
      expect(mockGetUserReputation).not.toHaveBeenCalled();
    });
  });

  describe("GET /users/:address/reputation", () => {
    it("returns reputation for a public wallet without authentication", async () => {
      mockGetUserReputation.mockResolvedValue(REPUTATION);

      const response = await request(app).get(`/users/${USER}/reputation`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(REPUTATION);
      expect(mockGetUserReputation).toHaveBeenCalledWith(USER);
    });

    it("returns 400 for a wallet rejected by validation", async () => {
      mockGetUserReputation.mockRejectedValue(
        new AppError(ErrorCode.VALIDATION_ERROR, "Invalid wallet address", 400),
      );

      const response = await request(app).get("/users/not-a-wallet/reputation");

      expect(response.status).toBe(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });
});
