import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";
import CooperativeBulkImportPage from "@/app/cooperative/bulk-import/page";
import { useAuth } from "@/hooks/useAuth";
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
jest.mock("@/lib/api", () => ({
  api: {
    trades: {
      bulkCreate: jest.fn(),
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
jest.mock("@/lib/analytics", () => ({
  trackAdminEvent: jest.fn(),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockBulkCreate = api.trades.bulkCreate as jest.MockedFunction<typeof api.trades.bulkCreate>;

const AUTH = {
  token: "jwt-token",
  isAuthenticated: true,
} as ReturnType<typeof useAuth>;

describe("Accessibility audit — /cooperative/bulk-import", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue(AUTH);
  });

  it("unauthenticated gate has no axe violations", async () => {
    mockUseAuth.mockReturnValue({ ...AUTH, isAuthenticated: false, token: null } as ReturnType<typeof useAuth>);
    const { container } = render(<CooperativeBulkImportPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Cooperative bulk import" }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("authenticated form with CSV textarea and import button has no axe violations", async () => {
    const { container } = render(<CooperativeBulkImportPage />);
    expect(screen.getByLabelText("Trades CSV")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import \d+ trade\(s\)/ })).toBeEnabled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("parse error message region has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<CooperativeBulkImportPage />);
    const textarea = screen.getByLabelText("Trades CSV");
    await user.clear(textarea);
    await user.type(textarea, "GAAAA,not-a-number,5000,5000");
    await waitFor(() => expect(screen.getByText(/error/)).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("bulk import failure error state has no axe violations", async () => {
    const user = userEvent.setup();
    mockBulkCreate.mockRejectedValue(new ApiError(500, "Bulk import failed"));
    const { container } = render(<CooperativeBulkImportPage />);
    await user.click(screen.getByRole("button", { name: /Import \d+ trade\(s\)/ }));
    await screen.findByText("Bulk import failed");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("success result section with per-row failures has no axe violations", async () => {
    const user = userEvent.setup();
    mockBulkCreate.mockResolvedValue({
      created: [{ index: 0, tradeId: "trade-1", unsignedXdr: "00TESTXDR" }],
      failed: [{ index: 1, error: "Invalid loss split" }],
    });
    const { container } = render(<CooperativeBulkImportPage />);
    await user.click(screen.getByRole("button", { name: /Import \d+ trade\(s\)/ }));
    expect(await screen.findByRole("heading", { name: "Result" })).toBeInTheDocument();
    expect(screen.getByText("Row 2: Invalid loss split")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
