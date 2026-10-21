"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchServerFlags,
  getFeatureFlags,
  type FeatureFlags,
  type FlagName,
} from "@/lib/featureFlags";

interface UseFeatureFlagsResult extends FeatureFlags {
  /** True while the first server fetch is in flight. */
  isLoading: boolean;
  /** Returns true if the named flag is enabled. */
  isFeatureEnabled: (feature: FlagName) => boolean;
  /** Manually trigger a flag refresh (e.g. after admin toggle). */
  refresh: () => void;
}

/**
 * Hook to access live feature flags in React components.
 *
 * Behaviour:
 *  - Initialises synchronously from env-var snapshot (no flicker on first render).
 *  - Triggers a server fetch on mount and replaces flags with the live values.
 *  - Respects the stale-while-revalidate cache in featureFlags.ts — subsequent
 *    renders are instantaneous if the cache is fresh.
 *  - On fetch failure the env-var snapshot remains (kill-switch / fail-safe).
 */
export function useFeatureFlags(): UseFeatureFlagsResult {
  // Synchronous initial value from env vars — avoids a loading flash on first render.
  const [flags, setFlags] = useState<FeatureFlags>(() => getFeatureFlags());
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);

  const load = useCallback(() => {
    setIsLoading(true);
    void fetchServerFlags().then((serverFlags) => {
      if (!mountedRef.current) return;
      setFlags(serverFlags);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Initial load fetches directly instead of going through `load`: `isLoading`
    // already starts true, so there is no need for `load`'s synchronous
    // setIsLoading(true) here (a cascading render). `refresh` still calls `load`
    // from event handlers, where a synchronous update is fine.
    void fetchServerFlags().then((serverFlags) => {
      if (!mountedRef.current) return;
      setFlags(serverFlags);
      setIsLoading(false);
    });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isFeatureEnabled = useCallback(
    (feature: FlagName) => flags[feature],
    [flags],
  );

  return useMemo(
    () => ({ ...flags, isLoading, isFeatureEnabled, refresh: load }),
    [flags, isLoading, isFeatureEnabled, load],
  );
}
