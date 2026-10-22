"use client";

/**
 * Dev-test fixtures for error boundary triggers.
 *
 * Listed under the "Error Boundary" section of /dev-test so QA and
 * developers can verify the branded fallback renders correctly without
 * needing to inject a real error at runtime.
 *
 * None of these are included in production builds — the /dev-test page
 * is excluded from Next.js output via next.config.ts in prod.
 */

import { useState } from "react";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

// ─── Helper components that deliberately crash ────────────────────────────

function CrashOnRender({ message }: { message: string }): never {
  throw new Error(message);
}

function CrashAfterDelay({ message, delayMs }: { message: string; delayMs: number }) {
  const [shouldCrash, setShouldCrash] = useState(false);

  if (shouldCrash) throw new Error(message);

  // Schedule crash
  setTimeout(() => setShouldCrash(true), delayMs);

  return (
    <div className="text-sm text-text-secondary">
      Crashing in {delayMs}ms…
    </div>
  );
}

function CrashWithBackendId(): never {
  const fakeError = new Error("Simulated backend-originated error");
  // Attach a fake backend correlation ID so the boundary can pick it up
  (fakeError as unknown as Record<string, unknown>).backendError = {
    correlationId: "backend-trace-00000001",
    requestId: "req-00000001",
    code: "INTERNAL_ERROR",
    message: "Simulated backend-originated error",
  };
  throw fakeError;
}

// ─── Fixture wrapper ──────────────────────────────────────────────────────

interface FixtureCardProps {
  label: string;
  description: string;
  children: React.ReactNode;
}

function FixtureCard({ label, description, children }: FixtureCardProps) {
  const [triggered, setTriggered] = useState(false);
  const [key, setKey] = useState(0);

  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-6 flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{label}</h3>
        <p className="text-xs text-text-muted mt-1">{description}</p>
      </div>

      {triggered ? (
        <ErrorBoundary
          key={key}
          onReset={() => {
            setKey((k) => k + 1);
            setTriggered(false);
          }}
        >
          {children}
        </ErrorBoundary>
      ) : (
        <button
          type="button"
          onClick={() => setTriggered(true)}
          className="self-start rounded-lg px-4 py-2 text-sm font-medium bg-status-danger/10 text-status-danger border border-status-danger/30 hover:bg-status-danger/20 transition-colors"
        >
          Trigger crash
        </button>
      )}
    </div>
  );
}

// ─── Public export ────────────────────────────────────────────────────────

export function ErrorBoundaryFixtures() {
  return (
    <section className="mb-12">
      <h2 className="text-xs font-semibold tracking-widest text-text-muted mb-1 uppercase">
        Error Boundary Fixtures
      </h2>
      <p className="text-text-muted text-xs mb-6">
        Click &quot;Trigger crash&quot; inside each card to verify the branded fallback.
        The &quot;Try again&quot; button resets the boundary — clicking it should restore
        the fixture card.
      </p>

      <div className="grid gap-6 md:grid-cols-2">
        <FixtureCard
          label="Immediate render crash"
          description="Component throws synchronously on first render."
        >
          <CrashOnRender message="Immediate render crash (dev-test fixture)" />
        </FixtureCard>

        <FixtureCard
          label="Async / delayed crash"
          description="Component crashes 800ms after mounting — simulates a delayed data error."
        >
          <CrashAfterDelay
            message="Delayed crash (dev-test fixture)"
            delayMs={800}
          />
        </FixtureCard>

        <FixtureCard
          label="Backend correlation ID propagation"
          description="Error carries a fake backendError.correlationId — boundary should display it instead of generating a new client ID."
        >
          <CrashWithBackendId />
        </FixtureCard>

        <FixtureCard
          label="Nested boundary isolation"
          description="Only the inner boundary catches the crash — outer boundary and siblings keep rendering."
        >
          <div className="flex flex-col gap-3">
            <div className="text-xs text-text-secondary px-2 py-1 bg-bg-elevated rounded">
              ↑ Outer boundary sibling (should stay visible)
            </div>
            <ErrorBoundary>
              <CrashOnRender message="Inner boundary crash (dev-test fixture)" />
            </ErrorBoundary>
            <div className="text-xs text-text-secondary px-2 py-1 bg-bg-elevated rounded">
              ↓ Outer boundary sibling (should stay visible)
            </div>
          </div>
        </FixtureCard>
      </div>
    </section>
  );
}
