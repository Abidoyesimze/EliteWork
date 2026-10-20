import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import MediatorDisputesPage from "@/app/mediator/disputes/page";
import { useAuth } from "@/hooks/useAuth";
import { useFreighterIdentity } from "@/hooks/useFreighterIdentity";
import { api, ApiError } from "@/lib/api";

expect.extend(toHaveNoViolations);

jest.mock("next/link", () => {
  const MockLink = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("@/hooks/useAuth");
jest.mock("@/hooks/useFreighterIdentity");
jest.mock("@/lib/api", () => ({
  api: {
    disputes: {
      list: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {
    status: number;
    data: unknown;
    constructor(status: number, message: string, data?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.data = data;
    }
  },
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseFreighterIdentity = useFreighterIdentity as jest.MockedFunction<
  typeof useFreighterIdentity
>;
const mockList = api.disputes.list as jest.MockedFunction<typeof api.disputes.list>;

const MEDIATOR_ADDRESS = "GEXAMPLEMEDIATORPUBLICKEY1";

function makeDispute(overrides = {}) {
  return {
    id: 1,
    tradeId: "trade-1",
    status: "OPEN" as const,
    initiator: "GBUYER1234567890",
    reason: "Non-delivery",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    trade: {
      buyerAddress: "GBUYER1234567890",
      sellerAddress: "GSELLER1234567890",
      amountUsdc: "100",
    },
    ...overrides,
  };
}

describe("Accessibility audit — /mediator/disputes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({
      token: "test-token",
      isAuthenticated: true,
    } as ReturnType<typeof useAuth>);
    mockUseFreighterIdentity.mockReturnValue({
      address: MEDIATOR_ADDRESS,
    } as ReturnType<typeof useFreighterIdentity>);
  });

  it("access-restricted gate for non-mediators has no axe violations", async () => {
    mockUseFreighterIdentity.mockReturnValue({
      address: "GNOTAMEDATOR1234567890",
    } as ReturnType<typeof useFreighterIdentity>);
    const { container } = render(<MediatorDisputesPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Access Restricted" }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("disputes list with filter tabs and dispute cards has no axe violations", async () => {
    mockList.mockResolvedValue({
      items: [makeDispute()],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });
    const { container } = render(<MediatorDisputesPage />);
    await waitFor(() => {
      expect(screen.getByRole("tablist")).toBeInTheDocument();
    });
    expect(screen.getByText(/Trade trade-1/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("empty dispute list has no axe violations", async () => {
    mockList.mockResolvedValue({
      items: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 1 },
    });
    const { container } = render(<MediatorDisputesPage />);
    await waitFor(() => {
      expect(screen.getByText("No disputes found")).toBeInTheDocument();
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("error state with retry has no axe violations", async () => {
    mockList.mockRejectedValue(new ApiError(500, "Failed to reach disputes service"));
    const { container } = render(<MediatorDisputesPage />);
    await waitFor(() => {
      expect(screen.getByText("Couldn't load disputes")).toBeInTheDocument();
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
