import type { Response } from "express";
import { getMe, getUserByAddress, updateMe } from "../controllers/user.controller";
import { AppError, ErrorCode } from "../errors/errorCodes";
import type { AuthRequest } from "../services/auth.service";
import * as userService from "../services/user.service";

jest.mock("../services/user.service", () => ({
  findOrCreateUser: jest.fn(),
  updateUser: jest.fn(),
  getPublicProfile: jest.fn(),
}));

const mockedUserService = userService as jest.Mocked<typeof userService>;

const WALLET = "GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_WALLET = "GOTHERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    body: {},
    params: {},
    user: { walletAddress: WALLET },
    ...overrides,
  } as unknown as AuthRequest;
}

/** The AppError passed to `next`, asserting there was exactly one. */
function forwardedError(next: jest.Mock): AppError {
  expect(next).toHaveBeenCalledTimes(1);
  const [error] = next.mock.calls[0];
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("UserController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getMe", () => {
    it("returns the caller's profile, creating it on first access", async () => {
      const profile = { walletAddress: WALLET, displayName: "Ada" };
      mockedUserService.findOrCreateUser.mockResolvedValue(profile as never);
      const res = mockResponse();
      const next = jest.fn();

      await getMe(mockRequest(), res, next);

      expect(mockedUserService.findOrCreateUser).toHaveBeenCalledWith(WALLET);
      expect(res.json).toHaveBeenCalledWith(profile);
      expect(next).not.toHaveBeenCalled();
    });

    it("forwards a 401 AppError when the caller is not authenticated", async () => {
      const res = mockResponse();
      const next = jest.fn();

      await getMe(mockRequest({ user: undefined }), res, next);

      const error = forwardedError(next);
      expect(error).toMatchObject({ code: ErrorCode.AUTH_ERROR, statusCode: 401, message: "Unauthorized" });
      expect(mockedUserService.findOrCreateUser).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("forwards service failures to the error handler", async () => {
      const failure = new Error("database unavailable");
      mockedUserService.findOrCreateUser.mockRejectedValue(failure);
      const res = mockResponse();
      const next = jest.fn();

      await getMe(mockRequest(), res, next);

      expect(next).toHaveBeenCalledWith(failure);
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe("updateMe", () => {
    it("updates the caller's own profile with the request body", async () => {
      const body = { displayName: "Ada Lovelace", bio: "Mathematician" };
      const updated = { walletAddress: WALLET, ...body };
      mockedUserService.updateUser.mockResolvedValue(updated as never);
      const res = mockResponse();
      const next = jest.fn();

      await updateMe(mockRequest({ body }), res, next);

      expect(mockedUserService.updateUser).toHaveBeenCalledWith(WALLET, body);
      expect(res.json).toHaveBeenCalledWith(updated);
      expect(next).not.toHaveBeenCalled();
    });

    it("always updates the authenticated wallet, never one named in the body", async () => {
      mockedUserService.updateUser.mockResolvedValue({ walletAddress: WALLET } as never);
      const body = { walletAddress: OTHER_WALLET, displayName: "Impostor" };

      await updateMe(mockRequest({ body }), mockResponse(), jest.fn());

      expect(mockedUserService.updateUser).toHaveBeenCalledWith(WALLET, body);
    });

    it("forwards a 401 AppError when the caller is not authenticated", async () => {
      const next = jest.fn();

      await updateMe(mockRequest({ user: undefined, body: { displayName: "x" } }), mockResponse(), next);

      expect(forwardedError(next)).toMatchObject({ code: ErrorCode.AUTH_ERROR, statusCode: 401 });
      expect(mockedUserService.updateUser).not.toHaveBeenCalled();
    });

    it("forwards service failures, such as validation errors, to the error handler", async () => {
      const failure = new AppError(ErrorCode.VALIDATION_ERROR, "displayName is too long", 400);
      mockedUserService.updateUser.mockRejectedValue(failure);
      const res = mockResponse();
      const next = jest.fn();

      await updateMe(mockRequest({ body: { displayName: "x".repeat(500) } }), res, next);

      expect(next).toHaveBeenCalledWith(failure);
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe("getUserByAddress", () => {
    it("returns the public profile for an address", async () => {
      const profile = { walletAddress: OTHER_WALLET, displayName: "Grace" };
      mockedUserService.getPublicProfile.mockResolvedValue(profile as never);
      const res = mockResponse();
      const next = jest.fn();

      await getUserByAddress(mockRequest({ params: { address: OTHER_WALLET } }), res, next);

      expect(mockedUserService.getPublicProfile).toHaveBeenCalledWith(OTHER_WALLET);
      expect(res.json).toHaveBeenCalledWith(profile);
      expect(next).not.toHaveBeenCalled();
    });

    it("uses the first value when the address param is an array", async () => {
      mockedUserService.getPublicProfile.mockResolvedValue({ walletAddress: OTHER_WALLET } as never);

      await getUserByAddress(
        mockRequest({ params: { address: [OTHER_WALLET, WALLET] } as never }),
        mockResponse(),
        jest.fn(),
      );

      expect(mockedUserService.getPublicProfile).toHaveBeenCalledWith(OTHER_WALLET);
    });

    it("does not require authentication", async () => {
      mockedUserService.getPublicProfile.mockResolvedValue({ walletAddress: OTHER_WALLET } as never);
      const res = mockResponse();
      const next = jest.fn();

      await getUserByAddress(mockRequest({ user: undefined, params: { address: OTHER_WALLET } }), res, next);

      expect(res.json).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it("forwards a 400 AppError when the address is missing", async () => {
      const next = jest.fn();

      await getUserByAddress(mockRequest({ params: {} }), mockResponse(), next);

      expect(forwardedError(next)).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        statusCode: 400,
        message: "Wallet address is required",
      });
      expect(mockedUserService.getPublicProfile).not.toHaveBeenCalled();
    });

    it("forwards a 404 AppError when no profile exists", async () => {
      mockedUserService.getPublicProfile.mockResolvedValue(null as never);
      const res = mockResponse();
      const next = jest.fn();

      await getUserByAddress(mockRequest({ params: { address: OTHER_WALLET } }), res, next);

      expect(forwardedError(next)).toMatchObject({
        code: ErrorCode.NOT_FOUND,
        statusCode: 404,
        message: "User not found",
      });
      expect(res.json).not.toHaveBeenCalled();
    });

    it("forwards service failures to the error handler", async () => {
      const failure = new Error("database unavailable");
      mockedUserService.getPublicProfile.mockRejectedValue(failure);
      const next = jest.fn();

      await getUserByAddress(mockRequest({ params: { address: OTHER_WALLET } }), mockResponse(), next);

      expect(next).toHaveBeenCalledWith(failure);
    });
  });
});
