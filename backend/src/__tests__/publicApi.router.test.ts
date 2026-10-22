import express from "express";
import request from "supertest";
import { AppError, ErrorCode } from "../errors/errorCodes";
import { errorHandler } from "../middleware/errorHandler";

const mockValidateToken = jest.fn();
const mockIsTokenRevoked = jest.fn();
const mockExportUserData = jest.fn();

jest.mock("../services/auth.service", () => ({
  AuthService: {
    validateToken: mockValidateToken,
    isTokenRevoked: mockIsTokenRevoked,
  },
}));

jest.mock("../services/privacy.service", () => ({
  exportUserData: mockExportUserData,
  eraseUserData: jest.fn(),
}));

import { createPublicApiRouter } from "../routes/publicApi.router";

const USER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createPublicApiRouter());
  app.use(errorHandler);
  return app;
}

describe("createPublicApiRouter", () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTokenRevoked.mockResolvedValue(false);
  });

  it("routes a successful request to a mounted consumer handler", async () => {
    const payload = { exportedAt: "2026-01-01T00:00:00.000Z", user: { walletAddress: USER } };
    mockValidateToken.mockResolvedValue({ walletAddress: USER, jti: "public-api-test" });
    mockExportUserData.mockResolvedValue(payload);

    const response = await request(app)
      .get("/api/v1/users/me/export")
      .set("Authorization", "Bearer valid.token.value");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(payload);
    expect(mockExportUserData).toHaveBeenCalledWith(USER);
  });

  it("preserves validation failures from a mounted handler", async () => {
    mockValidateToken.mockResolvedValue({ walletAddress: USER, jti: "public-api-test" });
    mockExportUserData.mockRejectedValue(
      new AppError(ErrorCode.VALIDATION_ERROR, "Invalid wallet address", 400),
    );

    const response = await request(app)
      .get("/api/v1/users/me/export")
      .set("Authorization", "Bearer valid.token.value");

    expect(response.status).toBe(400);
    expect(response.body.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("preserves authentication failures from a mounted handler", async () => {
    const response = await request(app).get("/api/v1/users/me/export");

    expect(response.status).toBe(401);
    expect(mockExportUserData).not.toHaveBeenCalled();
  });
});
