"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  /** The resolved theme actually applied (never "system"). */
  resolvedTheme: "light" | "dark";
  /** The user's stored preference (may be "system"). */
  themePreference: Theme;
  /** Set the theme preference. "system" follows OS preference. */
  setTheme: (theme: Theme) => void;
  /**
   * Apply a theme temporarily without persisting it. Call
   * {@link clearThemePreview} to snap back to the committed preference.
   */
  previewTheme: (theme: Theme) => void;
  /** Drop any temporary preview and restore the committed preference. */
  clearThemePreview: () => void;
  /** True while a temporary preview is being shown. */
  isPreviewing: boolean;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "amana-theme-preference";

function getSystemPreference(): "light" | "dark" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themePreference, setThemePreference] = useState<Theme>("system");
  // Resolved OS theme, tracked so a preview of "system" stays correct even
  // while the committed preference is something else.
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">("dark");
  const [mounted, setMounted] = useState(false);
  const [previewPreference, setPreviewPreference] = useState<Theme | null>(null);

  // A preview wins over the stored preference until it is cleared or committed.
  const effectivePreference = previewPreference ?? themePreference;
  const resolvedTheme: "light" | "dark" =
    effectivePreference === "system" ? systemTheme : effectivePreference;

  // Read persisted preference and apply it (no flash — applied before paint via
  // the inline script in <head> below).
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    // Hydration sync from an external store (localStorage), performed exactly
    // once on mount. The inline script in <head> has already applied the stored
    // theme class before paint, and syncing here (after hydration) keeps the
    // first client render identical to the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThemePreference(stored ?? "system");
    // The OS theme is read from the media query, not from the stored
    // preference — a "system" preview must reflect the real device setting even
    // when the committed preference is light or dark.
    setSystemTheme(getSystemPreference());
    setMounted(true);
  }, []);

  // Apply the `dark` class to <html> whenever resolvedTheme changes.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
  }, [resolvedTheme]);

  // Listen for OS-level preference changes. Stays subscribed regardless of the
  // active preference so "system" previews and a later switch stay accurate.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const setTheme = useCallback((theme: Theme) => {
    setThemePreference(theme);
    // Committing ends any preview — the committed value is the new preview.
    setPreviewPreference(null);
    localStorage.setItem(STORAGE_KEY, theme);

    // Briefly add transition class so the switch animates smoothly.
    document.documentElement.classList.add("theme-transition");
    setTimeout(() => {
      document.documentElement.classList.remove("theme-transition");
    }, 250);
  }, []);

  const previewTheme = useCallback((theme: Theme) => {
    setPreviewPreference(theme);
  }, []);

  const clearThemePreview = useCallback(() => {
    setPreviewPreference(null);
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        resolvedTheme,
        themePreference,
        setTheme,
        previewTheme,
        clearThemePreview,
        isPreviewing: previewPreference !== null,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Fallback for SSR or components rendered outside the provider — return
    // dark to match the default. This avoids a runtime error while the
    // provider hydrates.
    return {
      resolvedTheme: "dark",
      themePreference: "system",
      setTheme: () => {},
      previewTheme: () => {},
      clearThemePreview: () => {},
      isPreviewing: false,
    };
  }
  return ctx;
}
