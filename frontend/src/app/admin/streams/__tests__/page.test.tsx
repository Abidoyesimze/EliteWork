import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminStreamsPage from "../page";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { api, ApiError } from "@/lib/api";
import { trackAdminEvent } from "@/lib/analytics";
import { useToast } from "@/hooks/useToast";

jest.mock("@/hooks/useAuth");
jest.mock("@/hooks/useIsAdmin");
// The real virtualizer measures the DOM, so it renders no rows under jsdom.
// Render every stream in order instead — same approach as the audit page test.
jest.mock("@/components/ui/VirtualizedList", () => ({
  VirtualizedList: ({
    items,
    isEmpty,
    emptyState,
    renderItem,
    keyExtractor,
  }: {
    items: { streamId: string }[];
    isEmpty?: boolean;
    emptyState?: React.ReactNode;
    renderItem: (item: unknown, index: number) => React.ReactNode;
    keyExtractor: (item: unknown, index: number) => string;
  }) =>
    isEmpty ? (
      <div role="list" aria-label="Empty list">
        {emptyState}
      </div>
    ) : (
      <div role="list" aria-label="Virtualized list">
        {items.map((item, index) => (
          <div key={keyExtractor(item, index)} role="listitem">
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    ),
}));
jest.mock("@/hooks/useToast", () => ({
  useToast: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackAdminEvent: jest.fn(),
}));
jest.mock("@/lib/api", () => {
  const { ApiError: RealApiError } = jest.requireActual("@/lib/api/client");
  return {
    api: {
      adminStreams: {
        list: jest.fn(),
        clawbackPreview: jest.fn(),
      },
    },
    ApiError: RealApiError,
  };
});

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseIsAdmin = useIsAdmin as jest.MockedFunction<typeof useIsAdmin>;
const mockList = api.adminStreams.list as jest.MockedFunction<typeof api.adminStreams.list>;
const mockTrackAdminEvent = trackAdminEvent as jest.MockedFunction<typeof trackAdminEvent>;
const mockUseToast = useToast as jest.MockedFunction<typeof useToast>;

function makeStream(overrides = {}) {
  return {
    streamId: "stream-abc-123",
    recipient: "GRECIPIENT000000000000000000000000000000000000000000000",
    status: "ACTIVE" as const,
    vestingState: "vesting" as const,
    totalVested: "10000",
    claimed: "2500",
    unclaimed: "7500",
    pendingClawback: "0",
    adminTags: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("AdminStreamsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({
      token: "test-token",
      isAuthenticated: true,
    } as ReturnType<typeof useAuth>);
    mockUseIsAdmin.mockReturnValue(true);
    mockUseToast.mockReturnValue({
      toasts: [],
      addToast: jest.fn(),
      removeToast: jest.fn(),
    });
  });

  it("shows a ForbiddenState instead of fetching when the wallet is not an admin", () => {
    mockUseIsAdmin.mockReturnValue(false);

    render(<AdminStreamsPage />);

    expect(screen.getByTestId("forbidden-state")).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
    expect(screen.queryByText("Clawback")).not.toBeInTheDocument();
  });

  it("shows a skeleton while loading", () => {
    mockList.mockReturnValue(new Promise(() => {}));

    const { container } = render(<AdminStreamsPage />);

    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("lists streams with their remaining vested balance", async () => {
    mockList.mockResolvedValueOnce({
      items: [makeStream()],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    render(<AdminStreamsPage />);

    await waitFor(() => {
      expect(screen.getByText("stream-abc-123")).toBeInTheDocument();
    });
    expect(screen.getByText("7500")).toBeInTheDocument();
    expect(mockTrackAdminEvent).toHaveBeenCalledWith("admin_streams_page_view", "success", { page: 1 });
  });

  it("reveals the clawback form for an actionable stream when Clawback is clicked", async () => {
    mockList.mockResolvedValueOnce({
      items: [makeStream()],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    render(<AdminStreamsPage />);

    await waitFor(() => {
      expect(screen.getByText("stream-abc-123")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Clawback" }));

    expect(screen.getByLabelText(/Clawback amount/)).toBeInTheDocument();
  });

  it("does not offer a clawback action for a stream with nothing left to claw back", async () => {
    mockList.mockResolvedValueOnce({
      items: [makeStream({ unclaimed: "0" })],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    render(<AdminStreamsPage />);

    await waitFor(() => {
      expect(screen.getByText("stream-abc-123")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Clawback" })).not.toBeInTheDocument();
    expect(screen.getByText("No clawback available")).toBeInTheDocument();
  });

  it("shows a ForbiddenState when the backend returns a 403", async () => {
    mockList.mockRejectedValueOnce(new ApiError(403, "Forbidden: admin access required"));

    render(<AdminStreamsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("forbidden-state")).toBeInTheDocument();
    });
  });

  it("shows a retryable error state for non-403 failures", async () => {
    mockList.mockRejectedValueOnce(new ApiError(500, "Failed to reach admin streams service"));

    render(<AdminStreamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load streams")).toBeInTheDocument();
    });
    expect(screen.getByText("Failed to reach admin streams service")).toBeInTheDocument();
  });

  it("shows an empty state when there are no streams", async () => {
    mockList.mockResolvedValueOnce({
      items: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
    });

    render(<AdminStreamsPage />);

    await waitFor(() => {
      expect(screen.getByText("No streams to display")).toBeInTheDocument();
    });
  });
});
