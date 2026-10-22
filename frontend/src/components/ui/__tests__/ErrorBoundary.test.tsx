/**
 * Tests for the global ErrorBoundary component.
 *
 * Coverage targets (Issue #1 DoD):
 *   - Fallback renders without crashing itself
 *   - Correlation ID is present and non-empty
 *   - Retry ("Try again") resets the boundary and shows children again
 *   - Custom render-prop fallback receives error + correlationId + reset
 *   - Custom static-node fallback is rendered
 *   - onError callback fires with error + errorInfo
 *   - onReset callback fires on retry
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";

// Suppress React's error overlay noise in tests
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    const msg = String(args[0]);
    if (
      msg.includes("ErrorBoundary") ||
      msg.includes("The above error occurred") ||
      msg.includes("act(") ||
      msg.includes("[ErrorBoundary]")
    ) {
      return;
    }
    originalConsoleError(...args);
  };
});
afterAll(() => {
  console.error = originalConsoleError;
});

// ─── Helper: a component that always throws ─────────────────────────────────

function Bomb({ message = "Test explosion" }: { message?: string }) {
  throw new Error(message);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ErrorBoundary", () => {
  describe("happy path", () => {
    it("renders children when no error is thrown", () => {
      render(
        <ErrorBoundary>
          <div>All good</div>
        </ErrorBoundary>,
      );
      expect(screen.getByText("All good")).toBeInTheDocument();
    });
  });

  describe("default branded fallback", () => {
    it("renders fallback without throwing itself", () => {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
      expect(screen.getByTestId("error-boundary-fallback")).toBeInTheDocument();
    });

    it("shows 'Something went wrong' heading", () => {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
      expect(
        screen.getByRole("heading", { name: /something went wrong/i }),
      ).toBeInTheDocument();
    });

    it("shows a correlation ID in the fallback", () => {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
      const idEl = screen.getByTestId("correlation-id");
      expect(idEl.textContent).toBeTruthy();
      expect(idEl.textContent).toMatch(/^amana-/);
    });

    it("shows the retry button and the back-to-dashboard link", () => {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
      expect(screen.getByTestId("retry-button")).toBeInTheDocument();
      expect(screen.getByTestId("back-to-dashboard")).toBeInTheDocument();
    });

    it("has role=alert on the fallback container (accessibility)", () => {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("resets and re-renders children when retry is clicked", () => {
      let shouldThrow = true;

      function MaybeThrow() {
        if (shouldThrow) throw new Error("reset test");
        return <div>Recovered</div>;
      }

      const { rerender } = render(
        <ErrorBoundary>
          <MaybeThrow />
        </ErrorBoundary>,
      );

      expect(screen.getByTestId("error-boundary-fallback")).toBeInTheDocument();

      // Simulate recovery: stop throwing, then click retry
      shouldThrow = false;
      fireEvent.click(screen.getByTestId("retry-button"));

      rerender(
        <ErrorBoundary>
          <MaybeThrow />
        </ErrorBoundary>,
      );

      expect(screen.getByText("Recovered")).toBeInTheDocument();
    });

    it("respects custom backLabel and backHref props", () => {
      render(
        <ErrorBoundary backLabel="Back to trades" backHref="/trades">
          <Bomb />
        </ErrorBoundary>,
      );
      const link = screen.getByTestId("back-to-dashboard");
      expect(link).toHaveTextContent("Back to trades");
      expect(link).toHaveAttribute("href", "/trades");
    });
  });

  describe("custom fallback — static ReactNode", () => {
    it("renders the provided static fallback node", () => {
      render(
        <ErrorBoundary fallback={<div>Custom static fallback</div>}>
          <Bomb />
        </ErrorBoundary>,
      );
      expect(screen.getByText("Custom static fallback")).toBeInTheDocument();
    });

    it("does not render the default branded fallback", () => {
      render(
        <ErrorBoundary fallback={<div>Custom static fallback</div>}>
          <Bomb />
        </ErrorBoundary>,
      );
      expect(
        screen.queryByTestId("error-boundary-fallback"),
      ).not.toBeInTheDocument();
    });
  });

  describe("custom fallback — render prop", () => {
    it("calls the render prop with error, correlationId and reset", () => {
      const renderFn = jest.fn(
        ({
          error,
          correlationId,
        }: {
          error: Error;
          correlationId: string;
          reset: () => void;
        }) => (
          <div>
            <span data-testid="rp-message">{error.message}</span>
            <span data-testid="rp-correlation">{correlationId}</span>
          </div>
        ),
      );

      render(
        <ErrorBoundary fallback={renderFn}>
          <Bomb message="render-prop crash" />
        </ErrorBoundary>,
      );

      // React 19 re-renders the fallback while recovering from the caught
      // error, so the render prop can run more than once in development.
      // Assert the contract of the latest invocation instead of pinning the
      // render count.
      expect(renderFn).toHaveBeenCalled();
      const latest = renderFn.mock.calls[renderFn.mock.calls.length - 1][0];
      expect(latest.error).toBeInstanceOf(Error);
      expect(latest.error.message).toBe("render-prop crash");
      expect(latest.correlationId).toMatch(/^amana-/);
      expect(typeof latest.reset).toBe("function");
      expect(screen.getByTestId("rp-message")).toHaveTextContent(
        "render-prop crash",
      );
      expect(screen.getByTestId("rp-correlation").textContent).toMatch(
        /^amana-/,
      );
    });
  });

  describe("callbacks", () => {
    it("calls onError with the thrown error and errorInfo", () => {
      const onError = jest.fn();

      render(
        <ErrorBoundary onError={onError}>
          <Bomb message="callback test" />
        </ErrorBoundary>,
      );

      expect(onError).toHaveBeenCalledTimes(1);
      const [err, info] = onError.mock.calls[0] as [
        Error,
        { componentStack: string },
      ];
      expect(err.message).toBe("callback test");
      expect(info).toHaveProperty("componentStack");
    });

    it("calls onReset when the retry button is clicked", () => {
      const onReset = jest.fn();
      let shouldThrow = true;

      function MaybeThrow() {
        if (shouldThrow) throw new Error("reset callback test");
        return <div>OK</div>;
      }

      render(
        <ErrorBoundary onReset={onReset}>
          <MaybeThrow />
        </ErrorBoundary>,
      );

      shouldThrow = false;
      fireEvent.click(screen.getByTestId("retry-button"));
      expect(onReset).toHaveBeenCalledTimes(1);
    });
  });

  describe("backend correlation ID propagation", () => {
    it("uses backend correlationId when present on the error object", () => {
      function BombWithBackendId() {
        const err = new Error("backend id test") as Error & {
          backendError?: Record<string, string>;
        };
        err.backendError = {
          correlationId: "backend-trace-deadbeef",
          code: "INTERNAL_ERROR",
          message: "backend id test",
        };
        throw err;
      }

      render(
        <ErrorBoundary>
          <BombWithBackendId />
        </ErrorBoundary>,
      );

      // The correlation ID shown should be the backend one
      const idEl = screen.getByTestId("correlation-id");
      expect(idEl.textContent).toBe("backend-trace-deadbeef");
    });
  });
});
