/**
 * Controller-level unit tests for DisputeCategoryController.
 *
 * Mirrors the pattern in treasury.controller.test.ts: the controller is
 * instantiated directly with a mock service (no HTTP layer), so every handler
 * is exercised in isolation.
 *
 * Closes #228.
 */
import {
  DisputeCategoryController,
} from "../controllers/disputeCategory.controller";
import {
  DisputeCategoryNotFoundError,
  DisputeCategoryNameConflictError,
} from "../services/disputeCategory.service";
import type { Response, NextFunction } from "express";
import type { AuthRequest } from "../middleware/auth.middleware";

// ── helpers ─────────────────────────────────────────────────────────────────

const ADMIN_ADDRESS = "G" + "A".repeat(55);
const USER_ADDRESS = "G" + "B".repeat(55);

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockNext(): NextFunction {
  return jest.fn();
}

function makeRequest(
  overrides: Partial<AuthRequest> = {},
  walletAddress = ADMIN_ADDRESS,
): AuthRequest {
  return {
    user: { walletAddress },
    body: {},
    params: {},
    query: {},
    ...overrides,
  } as unknown as AuthRequest;
}

const mockDate = new Date("2026-05-27T00:00:00.000Z");

function makeCategory(overrides: Partial<{
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}> = {}) {
  return {
    id: 1,
    name: "DAMAGE",
    description: "Goods damaged in transit",
    isActive: true,
    createdAt: mockDate.toISOString(),
    updatedAt: mockDate.toISOString(),
    ...overrides,
  };
}

// ── setup ────────────────────────────────────────────────────────────────────

function makeMockService() {
  return {
    createCategory: jest.fn(),
    listCategories: jest.fn(),
    getCategoryById: jest.fn(),
    updateCategory: jest.fn(),
    deleteCategory: jest.fn(),
  };
}

beforeAll(() => {
  process.env.ADMIN_STELLAR_PUBKEYS = ADMIN_ADDRESS;
});

afterEach(() => {
  jest.clearAllMocks();
});

// ── createCategory ───────────────────────────────────────────────────────────

describe("DisputeCategoryController.createCategory()", () => {
  it("returns 201 with the created category for an admin caller", async () => {
    const service = makeMockService();
    service.createCategory.mockResolvedValue(makeCategory());
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ body: { name: "DAMAGE", description: "Goods damaged in transit" } });
    const res = mockRes();
    const next = mockNext();

    await controller.createCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(makeCategory());
    expect(service.createCategory).toHaveBeenCalledWith(req.body);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when req.user is absent", async () => {
    const service = makeMockService();
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ user: undefined });
    const res = mockRes();
    const next = mockNext();

    await controller.createCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
    expect(service.createCategory).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a mediator address", async () => {
    const service = makeMockService();
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ body: { name: "DAMAGE" } }, USER_ADDRESS);
    const res = mockRes();
    const next = mockNext();

    await controller.createCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Forbidden: mediator access required" });
    expect(service.createCategory).not.toHaveBeenCalled();
  });

  it("returns 409 on DisputeCategoryNameConflictError", async () => {
    const service = makeMockService();
    service.createCategory.mockRejectedValue(
      new DisputeCategoryNameConflictError("DAMAGE"),
    );
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ body: { name: "DAMAGE" } });
    const res = mockRes();
    const next = mockNext();

    await controller.createCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("DAMAGE") }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("delegates unexpected errors to next()", async () => {
    const service = makeMockService();
    const boom = new Error("DB exploded");
    service.createCategory.mockRejectedValue(boom);
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ body: { name: "DAMAGE" } });
    const res = mockRes();
    const next = mockNext();

    await controller.createCategory(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});

// ── listCategories ───────────────────────────────────────────────────────────

describe("DisputeCategoryController.listCategories()", () => {
  it("returns 200 with { items } for any authenticated user", async () => {
    const service = makeMockService();
    service.listCategories.mockResolvedValue([makeCategory()]);
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ query: {} }, USER_ADDRESS);
    const res = mockRes();
    const next = mockNext();

    await controller.listCategories(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ items: [makeCategory()] });
    expect(service.listCategories).toHaveBeenCalledWith(false);
  });

  it("passes includeInactive=true to service when set by an admin", async () => {
    const service = makeMockService();
    service.listCategories.mockResolvedValue([makeCategory(), makeCategory({ id: 2, name: "RETIRED", isActive: false })]);
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ query: { includeInactive: true } });
    const res = mockRes();
    const next = mockNext();

    await controller.listCategories(req, res, next);

    expect(service.listCategories).toHaveBeenCalledWith(true);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 403 when a non-admin requests includeInactive=true", async () => {
    const service = makeMockService();
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ query: { includeInactive: true } }, USER_ADDRESS);
    const res = mockRes();
    const next = mockNext();

    await controller.listCategories(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(service.listCategories).not.toHaveBeenCalled();
  });

  it("delegates unexpected errors to next()", async () => {
    const service = makeMockService();
    const boom = new Error("unexpected");
    service.listCategories.mockRejectedValue(boom);
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ query: {} }, USER_ADDRESS);
    const res = mockRes();
    const next = mockNext();

    await controller.listCategories(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});

// ── getCategoryById ──────────────────────────────────────────────────────────

describe("DisputeCategoryController.getCategoryById()", () => {
  it("returns 200 with the category for any authenticated user", async () => {
    const service = makeMockService();
    service.getCategoryById.mockResolvedValue(makeCategory());
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 1 } }, USER_ADDRESS);
    const res = mockRes();
    const next = mockNext();

    await controller.getCategoryById(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(makeCategory());
    expect(service.getCategoryById).toHaveBeenCalledWith(1);
  });

  it("returns 404 on DisputeCategoryNotFoundError", async () => {
    const service = makeMockService();
    service.getCategoryById.mockRejectedValue(new DisputeCategoryNotFoundError(99));
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 99 } }, USER_ADDRESS);
    const res = mockRes();
    const next = mockNext();

    await controller.getCategoryById(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("99") }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("delegates unexpected errors to next()", async () => {
    const service = makeMockService();
    const boom = new Error("DB timeout");
    service.getCategoryById.mockRejectedValue(boom);
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 1 } }, USER_ADDRESS);
    const res = mockRes();
    const next = mockNext();

    await controller.getCategoryById(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});

// ── updateCategory ───────────────────────────────────────────────────────────

describe("DisputeCategoryController.updateCategory()", () => {
  it("returns 200 with the updated category for an admin caller", async () => {
    const updated = makeCategory({ name: "RENAMED" });
    const service = makeMockService();
    service.updateCategory.mockResolvedValue(updated);
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 1 }, body: { name: "RENAMED" } });
    const res = mockRes();
    const next = mockNext();

    await controller.updateCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(updated);
    expect(service.updateCategory).toHaveBeenCalledWith(1, { name: "RENAMED" });
  });

  it("returns 401 when req.user is absent", async () => {
    const service = makeMockService();
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ user: undefined, params: { id: 1 }, body: { name: "X" } });
    const res = mockRes();
    const next = mockNext();

    await controller.updateCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(service.updateCategory).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a mediator", async () => {
    const service = makeMockService();
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 1 }, body: { name: "X" } }, USER_ADDRESS);
    const res = mockRes();
    const next = mockNext();

    await controller.updateCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(service.updateCategory).not.toHaveBeenCalled();
  });

  it("returns 404 on DisputeCategoryNotFoundError", async () => {
    const service = makeMockService();
    service.updateCategory.mockRejectedValue(new DisputeCategoryNotFoundError(99));
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 99 }, body: { name: "X" } });
    const res = mockRes();
    const next = mockNext();

    await controller.updateCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 409 on DisputeCategoryNameConflictError", async () => {
    const service = makeMockService();
    service.updateCategory.mockRejectedValue(
      new DisputeCategoryNameConflictError("DAMAGE"),
    );
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 1 }, body: { name: "DAMAGE" } });
    const res = mockRes();
    const next = mockNext();

    await controller.updateCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(next).not.toHaveBeenCalled();
  });

  it("delegates unexpected errors to next()", async () => {
    const service = makeMockService();
    const boom = new Error("network issue");
    service.updateCategory.mockRejectedValue(boom);
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 1 }, body: { name: "X" } });
    const res = mockRes();
    const next = mockNext();

    await controller.updateCategory(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});

// ── deleteCategory ───────────────────────────────────────────────────────────

describe("DisputeCategoryController.deleteCategory()", () => {
  it("returns 204 on successful delete by an admin caller", async () => {
    const service = makeMockService();
    service.deleteCategory.mockResolvedValue(undefined);
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 1 } });
    const res = mockRes();
    const next = mockNext();

    await controller.deleteCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
    expect(service.deleteCategory).toHaveBeenCalledWith(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when req.user is absent", async () => {
    const service = makeMockService();
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ user: undefined, params: { id: 1 } });
    const res = mockRes();
    const next = mockNext();

    await controller.deleteCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(service.deleteCategory).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a mediator", async () => {
    const service = makeMockService();
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 1 } }, USER_ADDRESS);
    const res = mockRes();
    const next = mockNext();

    await controller.deleteCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(service.deleteCategory).not.toHaveBeenCalled();
  });

  it("returns 404 on DisputeCategoryNotFoundError", async () => {
    const service = makeMockService();
    service.deleteCategory.mockRejectedValue(new DisputeCategoryNotFoundError(99));
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 99 } });
    const res = mockRes();
    const next = mockNext();

    await controller.deleteCategory(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("99") }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("delegates unexpected errors to next()", async () => {
    const service = makeMockService();
    const boom = new Error("unexpected delete error");
    service.deleteCategory.mockRejectedValue(boom);
    const controller = new DisputeCategoryController(service as any);

    const req = makeRequest({ params: { id: 1 } });
    const res = mockRes();
    const next = mockNext();

    await controller.deleteCategory(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});
