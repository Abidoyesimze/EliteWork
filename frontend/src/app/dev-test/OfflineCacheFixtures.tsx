"use client";

/**
 * Dev-test fixtures for the offline cache layer.
 *
 * Demonstrates:
 *   - StalenessIndicator in each state (fresh / stale / offline)
 *   - Cache write / read / invalidate via direct offlineCache calls
 */

import { useState } from "react";
import { StalenessIndicator } from "@/components/ui/StalenessIndicator";
import {
  cacheWrite,
  cacheRead,
  cacheInvalidate,
  getCacheUsageBytes,
  QUOTA_BYTES,
} from "@/lib/offlineCache";

/** Fixture clock — read once at module load so render stays pure. */
const DEMO_NOW = Date.now();

export function OfflineCacheFixtures() {
  const [readResult, setReadResult] = useState<string>("—");
  const [usageBytes, setUsageBytes] = useState(0);

  function handleWrite() {
    cacheWrite("trades_list", "dev-test-key", {
      items: [{ tradeId: "dev-1", status: "OPEN" }],
      cachedAt: Date.now(),
    });
    setUsageBytes(getCacheUsageBytes());
    setReadResult("written ✓");
  }

  function handleRead() {
    const result = cacheRead("trades_list", "dev-test-key");
    if (result.isMiss) {
      setReadResult("miss (no entry)");
    } else if (result.isStale) {
      setReadResult(`stale hit — cachedAt: ${result.entry?.cachedAt}`);
    } else {
      setReadResult(`fresh hit — cachedAt: ${result.entry?.cachedAt}`);
    }
    setUsageBytes(getCacheUsageBytes());
  }

  function handleInvalidate() {
    cacheInvalidate("trades_list", "dev-test-key");
    setUsageBytes(getCacheUsageBytes());
    setReadResult("invalidated ✓");
  }

  const quotaPct = ((usageBytes / QUOTA_BYTES) * 100).toFixed(1);

  return (
    <section className="mb-12">
      <h2 className="text-xs font-semibold tracking-widest text-text-muted mb-1 uppercase">
        Offline Cache Fixtures
      </h2>
      <p className="text-text-muted text-xs mb-6">
        Write / read / invalidate a test entry from the localStorage cache.
      </p>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Cache controls */}
        <div className="bg-bg-card border border-border-default rounded-xl p-6 flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-text-primary">Cache controls</h3>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleWrite}
              className="rounded-lg px-4 py-2 text-sm font-medium bg-accent-gold text-text-inverse hover:bg-accent-gold-hover transition-colors"
            >
              Write entry
            </button>
            <button
              type="button"
              onClick={handleRead}
              className="rounded-lg px-4 py-2 text-sm font-medium bg-bg-elevated border border-border-default text-text-primary hover:bg-bg-elevated/80 transition-colors"
            >
              Read entry
            </button>
            <button
              type="button"
              onClick={handleInvalidate}
              className="rounded-lg px-4 py-2 text-sm font-medium bg-status-danger/10 text-status-danger border border-status-danger/30 hover:bg-status-danger/20 transition-colors"
            >
              Invalidate
            </button>
          </div>
          <code className="text-xs font-mono text-accent-teal bg-bg-elevated rounded px-3 py-2">
            {readResult}
          </code>
          <p className="text-xs text-text-muted">
            Storage used: {(usageBytes / 1024).toFixed(1)} KB / {(QUOTA_BYTES / 1024).toFixed(0)} KB
            ({quotaPct}%)
          </p>
        </div>

        {/* StalenessIndicator states */}
        <div className="bg-bg-card border border-border-default rounded-xl p-6 flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-text-primary">
            StalenessIndicator — all states
          </h3>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-24">Fresh:</span>
              <StalenessIndicator isStale={false} isOffline={false} cachedAt={DEMO_NOW} />
              <span className="text-xs text-text-muted italic">(no badge rendered)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-24">Stale:</span>
              <StalenessIndicator
                isStale={true}
                isOffline={false}
                cachedAt={DEMO_NOW - 8 * 60 * 1000}
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-24">Offline:</span>
              <StalenessIndicator
                isStale={true}
                isOffline={true}
                cachedAt={DEMO_NOW - 12 * 60 * 1000}
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-24">Live:</span>
              <StalenessIndicator
                isStale={true}
                isOffline={false}
                cachedAt={DEMO_NOW - 8 * 60 * 1000}
                live
              />
              <span className="text-xs text-text-muted italic">
                opt-in, re-reads the clock every minute
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
