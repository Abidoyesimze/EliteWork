import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";
import AssetsPage from "@/app/assets/page";
import { useAuth } from "@/hooks/useAuth";
import { api } from "@/lib/api";

expect.extend(toHaveNoViolations);

jest.mock("next/link", () => {
  const MockLink = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("next/navigation", () => ({
  usePathname: () => "/assets",
}));

jest.mock("@/hooks/useAuth");
jest.mock("@/lib/api", () => ({
  api: {
    trades: {
      getStats: jest.fn(),
      list: jest.fn(),
    },
    wallet: {
      getBalance: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

const AUTH = {
  shortAddress: "GABCD...F1234",
  token: "jwt-token",
  isAuthenticated: true,
  isWalletConnected: true,
  isLoading: false,
  connectWallet: jest.fn(),
  authenticate: jest.fn(),
} as unknown as ReturnType<typeof useAuth>;

const TRADES = [
  {
    tradeId: "trade-active-0001",
    buyerAddress: "GBUYER1234567890",
    sellerAddress: "GSELLER1234567890",
    amountCngn: "1000",
    amountUsdc: "1000",
    status: "FUNDED",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
  },
  {
    tradeId: "trade-completed-0002",
    buyerAddress: "GBUYER1234567890",
    sellerAddress: "GSELLER1234567890",
    amountCngn: "2500",
    amountUsdc: "2500",
    status: "COMPLETED",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-04T00:00:00Z",
  },
];

async function renderLoadedPage() {
  const view = render(<AssetsPage />);
  await waitFor(() => expect(screen.queryAllByText("—")).toHaveLength(0));
  return view;
}

describe("Accessibility audit — /assets", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue(AUTH);
    (api.trades.getStats as jest.Mock).mockResolvedValue({
      totalTrades: 2,
      openTrades: 1,
      totalVolume: 3500,
    });
    (api.trades.list as jest.Mock).mockResolvedValue({ items: TRADES });
    (api.wallet.getBalance as jest.Mock).mockResolvedValue({
      balance: "5000",
      asset: "cNGN",
    });
  });

  it("unauthenticated wallet-connect banner has no axe violations", async () => {
    mockUseAuth.mockReturnValue({
      ...AUTH,
      isAuthenticated: false,
      token: null,
      isWalletConnected: false,
    });
    const { container } = render(<AssetsPage />);
    expect(screen.getByText("Connect your wallet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Freighter" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("loaded portfolio with summary cards and asset table has no axe violations", async () => {
    const { container } = await renderLoadedPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Asset Management" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Search assets")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Asset navigation" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("search-filtered table has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = await renderLoadedPage();
    await user.type(screen.getByLabelText("Search assets"), "trade-active");
    await waitFor(() => {
      expect(screen.queryByText("trade-completed-0002")).not.toBeInTheDocument();
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("status-filtered table has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = await renderLoadedPage();
    await user.click(screen.getByRole("button", { name: "Completed" }));
    await waitFor(() => {
      expect(screen.queryByText("trade-active-0001")).not.toBeInTheDocument();
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
