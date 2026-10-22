import type { NextFunction, Response } from "express";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  requireCooperativeAdmin,
  requireCooperativeMember,
} from "../middleware/cooperative.middleware";
import * as cooperativeAccess from "../lib/cooperativeAccess";
import type { AuthRequest } from "../services/auth.service";

const COOP = "coop-north";
const COOP_ADMIN = "GCOOPADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COOP_MEMBER = "GCOOPMEMBERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const GLOBAL_ADMIN = "GGLOBALADMINCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const STRANGER = "GSTRANGERDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockRequest(walletAddress: string | undefined, id: string | string[] = COOP): AuthRequest {
  return {
    params: { id },
    user: walletAddress === undefined ? undefined : { walletAddress },
  } as unknown as AuthRequest;
}

function fakeSpan() {
  return { setAttributes: jest.fn(), setStatus: jest.fn() };
}

describe("cooperative.middleware", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.COOPERATIVE_ADMINS = `${COOP}:${COOP_ADMIN}`;
    process.env.COOPERATIVE_MEMBERS = `${COOP}:${COOP_MEMBER}`;
    process.env.ADMIN_STELLAR_PUBKEYS = GLOBAL_ADMIN;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  describe("requireCooperativeAdmin", () => {
    it("passes a cooperative admin through to the next handler", () => {
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      requireCooperativeAdmin(mockRequest(COOP_ADMIN), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("matches wallet and cooperative id case-insensitively and ignores surrounding whitespace", () => {
      const next: NextFunction = jest.fn();

      requireCooperativeAdmin(mockRequest(`  ${COOP_ADMIN.toLowerCase()}  `, COOP.toUpperCase()), mockResponse(), next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("passes a global admin (ADMIN_STELLAR_PUBKEYS) through for any cooperative", () => {
      const next: NextFunction = jest.fn();

      requireCooperativeAdmin(mockRequest(GLOBAL_ADMIN, "some-other-coop"), mockResponse(), next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("uses the first value when the id param is an array", () => {
      const next: NextFunction = jest.fn();

      requireCooperativeAdmin(mockRequest(COOP_ADMIN, [COOP, "ignored"]), mockResponse(), next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("rejects an unauthenticated request with 401", () => {
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      requireCooperativeAdmin(mockRequest(undefined), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects a blank wallet address with 401", () => {
      const res = mockResponse();

      requireCooperativeAdmin(mockRequest("   "), res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("rejects a member who is not an admin with 403", () => {
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      requireCooperativeAdmin(mockRequest(COOP_MEMBER), res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: "Forbidden: cooperative admin access required" });
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects an admin of a different cooperative with 403", () => {
      const res = mockResponse();

      requireCooperativeAdmin(mockRequest(COOP_ADMIN, "coop-south"), res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("records a denied verdict on the active span", () => {
      const span = fakeSpan();
      jest.spyOn(trace, "getActiveSpan").mockReturnValue(span as never);

      requireCooperativeAdmin(mockRequest(STRANGER), mockResponse(), jest.fn());

      expect(span.setAttributes).toHaveBeenCalledWith({
        "coop.attempted": true,
        "coop.verdict": "denied",
        "coop.address": STRANGER.toLowerCase(),
        "coop.id": COOP,
      });
      expect(span.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "Forbidden: cooperative admin access required",
      });
    });

    it("records a granted verdict on the active span", () => {
      const span = fakeSpan();
      jest.spyOn(trace, "getActiveSpan").mockReturnValue(span as never);

      requireCooperativeAdmin(mockRequest(COOP_ADMIN), mockResponse(), jest.fn());

      expect(span.setAttributes).toHaveBeenCalledWith({
        "coop.action": "privileged",
        "coop.address": COOP_ADMIN.toLowerCase(),
        "coop.verdict": "granted",
        "coop.id": COOP,
      });
      expect(span.setStatus).not.toHaveBeenCalled();
    });

    it("still grants access when telemetry throws", () => {
      jest.spyOn(trace, "getActiveSpan").mockImplementation(() => {
        throw new Error("tracer unavailable");
      });
      const next: NextFunction = jest.fn();

      requireCooperativeAdmin(mockRequest(COOP_ADMIN), mockResponse(), next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("still denies access when telemetry throws", () => {
      jest.spyOn(trace, "getActiveSpan").mockImplementation(() => {
        throw new Error("tracer unavailable");
      });
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      requireCooperativeAdmin(mockRequest(STRANGER), res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("propagates an access-lookup failure to the caller instead of granting access", () => {
      jest.spyOn(cooperativeAccess, "isCooperativeAdmin").mockImplementation(() => {
        throw new Error("allowlist unavailable");
      });
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      // Express catches a synchronous throw and routes it to the error handler.
      expect(() => requireCooperativeAdmin(mockRequest(COOP_ADMIN), res, next)).toThrow("allowlist unavailable");
      expect(next).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("requireCooperativeMember", () => {
    it.each([
      ["a cooperative member", COOP_MEMBER],
      ["a cooperative admin", COOP_ADMIN],
      ["a global admin", GLOBAL_ADMIN],
    ])("passes %s through to the next handler", (_label, wallet) => {
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      requireCooperativeMember(mockRequest(wallet), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("uses the first value when the id param is an array", () => {
      const next: NextFunction = jest.fn();

      requireCooperativeMember(mockRequest(COOP_MEMBER, [COOP, "ignored"]), mockResponse(), next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("matches a member case-insensitively", () => {
      const next: NextFunction = jest.fn();

      requireCooperativeMember(mockRequest(COOP_MEMBER.toLowerCase(), COOP.toUpperCase()), mockResponse(), next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("rejects an unauthenticated request with 401", () => {
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      requireCooperativeMember(mockRequest(undefined), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects a non-member with 403", () => {
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      requireCooperativeMember(mockRequest(STRANGER), res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: "Forbidden: cooperative member access required" });
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects a member of a different cooperative with 403", () => {
      const res = mockResponse();

      requireCooperativeMember(mockRequest(COOP_MEMBER, "coop-south"), res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("rejects everyone but global admins when no cooperative allowlists are configured", () => {
      delete process.env.COOPERATIVE_ADMINS;
      delete process.env.COOPERATIVE_MEMBERS;
      const memberRes = mockResponse();
      const adminNext: NextFunction = jest.fn();

      requireCooperativeMember(mockRequest(COOP_MEMBER), memberRes, jest.fn());
      requireCooperativeMember(mockRequest(GLOBAL_ADMIN), mockResponse(), adminNext);

      expect(memberRes.status).toHaveBeenCalledWith(403);
      expect(adminNext).toHaveBeenCalledTimes(1);
    });

    it("propagates a membership-lookup failure to the caller instead of granting access", () => {
      jest.spyOn(cooperativeAccess, "getCooperativeMembers").mockImplementation(() => {
        throw new Error("membership store unavailable");
      });
      const res = mockResponse();
      const next: NextFunction = jest.fn();

      expect(() => requireCooperativeMember(mockRequest(COOP_MEMBER), res, next)).toThrow(
        "membership store unavailable",
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
