"use client";

/**
 * StalenessIndicator — shows how fresh cached data is.
 *
 * Rendered inline next to section headings when:
 *   - `isStale` is true  →  amber "Stale" badge with elapsed time
 *   - `isOffline` is true AND data exists  →  grey "Offline" badge
 *   - data is live  →  nothing rendered (no badge)
 *
 * `Date.now()` is read once per render on purpose: re-rendering on a timer
 * would keep every mounted badge (and its subtree) awake for no benefit on
 * pages that come and go in seconds. Pages that stay open, however, would
 * otherwise show a stale label that stops being true — so `live` is the
 * opt-in that starts a one-minute tick for as long as a badge is visible.
 *
 * Usage:
 *   <StalenessIndicator isStale={isStale} cachedAt={cachedAt} isOffline={isOffline} />
 *   <StalenessIndicator isStale cachedAt={cachedAt} isOffline={false} live />
 */

import { clsx } from "clsx";
import { useEffect, useState } from "react";

/** Cadence of the `live` variant — one tick per minute. */
export const LIVE_REFRESH_MS = 60_000;

interface StalenessIndicatorProps {
  isStale: boolean;
  isOffline: boolean;
  /** Unix ms timestamp from CacheEntry.cachedAt */
  cachedAt: number | null;
  className?: string;
  /**
   * Opt-in for long-open pages: recompute the elapsed time every minute so
   * the "· 12m ago" suffix keeps counting instead of silently going out of
   * date. Defaults to false (read-once-per-render behaviour).
   */
  live?: boolean;
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export function StalenessIndicator({
  isStale,
  isOffline,
  cachedAt,
  className,
  live = false,
}: StalenessIndicatorProps) {
  const [, setTick] = useState(0);
  const badgeVisible = isStale || isOffline;
  const shouldTick = live && badgeVisible;

  // Hooks run before the early return below, so the effect always has a
  // chance to register (and to unregister) its interval.
  useEffect(() => {
    if (!shouldTick) return;
    const id = setInterval(() => setTick((tick) => tick + 1), LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [shouldTick]);

  if (!badgeVisible) return null;

  // `Date.now()` is read once per render on purpose — see the doc comment at
  // the top of this file. Re-rendering on a timer would keep every mounted
  // badge (and its subtree) awake for no benefit on short-lived pages.
  // eslint-disable-next-line react-hooks/purity
  const elapsed = cachedAt ? Date.now() - cachedAt : null;
  const label = isOffline ? "Offline" : "Stale";
  const timeLabel = elapsed !== null ? formatElapsed(elapsed) : null;

  return (
    <span
      role="status"
      aria-label={
        isOffline
          ? "Showing offline cached data"
          : `Showing stale data cached ${timeLabel ?? "recently"}`
      }
      data-testid="staleness-indicator"
      data-live={live ? "true" : "false"}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        isOffline
          ? "bg-bg-elevated text-text-muted border border-border-default"
          : "bg-status-warning/10 text-status-warning border border-status-warning/20",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "h-1.5 w-1.5 rounded-full flex-shrink-0",
          isOffline ? "bg-text-muted" : "bg-status-warning",
        )}
      />
      {label}
      {timeLabel && !isOffline && (
        <span className="text-text-muted font-normal">· {timeLabel}</span>
      )}
    </span>
  );
}
