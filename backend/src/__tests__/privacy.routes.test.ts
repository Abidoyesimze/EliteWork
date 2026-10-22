import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import { AppError, ErrorCode } from "../errors/errorCodes";
import { errorHandler } from "../middleware/errorHandler";

const mockExportUserData = jest.fn();
const mockEraseUserData = jest.fn();

jest.mock("../services/privacy.service", () => ({
  exportUserData: mockExportUserData,
  eraseUserData: mockEraseUserData,
}));

jest.mock("../middleware/auth.middleware", () => ({
  authMiddleware: (req: Request & { user?: { walletAddress: string } }, res: Response, next: NextFunction) => {
    const address = req.header("x-test-user");
    if (!address) return res.status(401).json({ error: "Unauthorized" });
    req.user = { walletAddress: address };
    next();
  },
}));

jest.mock("../middleware/admin.middleware", () => ({
  adminMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (req.header("x-test-admin") !== "true") {
      return res.status(403).json({ error: "Forbidden: admin access required" });
    }
    next();
  },
}));

import { createPrivacyRouter } from "../routes/privacy.routes";

const USER = "GUSER";
const TARGET = "GTARGET";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createPrivacyRouter());
  app.use(errorHandler);
  return app;
}

describe("privacy routes", () => {
  const app = buildApp();

  beforeEach(() => jest.clearAllMocks());

  describe.each([
    ["GET", "/users/me/export", mockExportUserData, { data: { profile: { walletAddress: USER } } }],
    ["DELETE", "/users/me", mockEraseUserData, { erased: true }],
  ] as const)("%s %s", (method, path, service, payload) => {
    it("returns the service response for the authenticated user", async () => {
      service.mockResolvedValue(payload);

      const response = await request(app)[method.toLowerCase() as "get" | "delete"](path)
        .set("x-test-user", USER);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(payload);
      expect(service).toHaveBeenCalledWith(USER);
    });

    it("returns 400 when the service rejects the wallet address", async () => {
      service.mockRejectedValue(new AppError(ErrorCode.VALIDATION_ERROR, "Invalid wallet address", 400));

      const response = await request(app)[method.toLowerCase() as "get" | "delete"](path)
        .set("x-test-user", USER);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it("returns 401 without authentication", async () => {
      const response = await request(app)[method.toLowerCase() as "get" | "delete"](path);

      expect(response.status).toBe(401);
      expect(service).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ["GET", `/admin/privacy/users/${TARGET}/export`, mockExportUserData, { data: { profile: { walletAddress: TARGET } } }],
    ["DELETE", `/admin/privacy/users/${TARGET}`, mockEraseUserData, { erased: true }],
  ] as const)("%s %s", (method, path, service, payload) => {
    it("returns the service response for an administrator", async () => {
      service.mockResolvedValue(payload);

      const response = await request(app)[method.toLowerCase() as "get" | "delete"](path)
        .set("x-test-user", USER)
        .set("x-test-admin", "true");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(payload);
      expect(service).toHaveBeenCalledWith(TARGET);
    });

    it("returns 400 when the service rejects the target wallet", async () => {
      service.mockRejectedValue(new AppError(ErrorCode.VALIDATION_ERROR, "Invalid wallet address", 400));

      const response = await request(app)[method.toLowerCase() as "get" | "delete"](path)
        .set("x-test-user", USER)
        .set("x-test-admin", "true");

      expect(response.status).toBe(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it("returns 401 without authentication and 403 for a non-admin", async () => {
      const unauthenticated = await request(app)[method.toLowerCase() as "get" | "delete"](path);
      const nonAdmin = await request(app)[method.toLowerCase() as "get" | "delete"](path)
        .set("x-test-user", USER);

      expect(unauthenticated.status).toBe(401);
      expect(nonAdmin.status).toBe(403);
      expect(service).not.toHaveBeenCalled();
    });
  });
});
