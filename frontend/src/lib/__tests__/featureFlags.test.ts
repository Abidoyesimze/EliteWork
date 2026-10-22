import {
  getFeatureFlags,
  isAdminUIEnabled,
  isFeatureEnabled,
  FLAG_CATALOG,
} from "../featureFlags";

describe("Feature Flags", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("getFeatureFlags", () => {
    it("returns all feature flags", () => {
      const flags = getFeatureFlags();
      expect(flags).toHaveProperty("adminUI");
    });

    it("defaults adminUI to false when env var is not set", () => {
      delete process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI;
      const flags = getFeatureFlags();
      expect(flags.adminUI).toBe(false);
    });

    it("sets adminUI to true when env var is 'true'", () => {
      process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI = "true";
      const flags = getFeatureFlags();
      expect(flags.adminUI).toBe(true);
    });

    it("sets adminUI to false when env var is 'false'", () => {
      process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI = "false";
      const flags = getFeatureFlags();
      expect(flags.adminUI).toBe(false);
    });

    it("sets adminUI to false for any non-'true' value", () => {
      const testValues = ["1", "yes", "TRUE", "True", "enabled", ""];
      
      testValues.forEach((value) => {
        process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI = value;
        const flags = getFeatureFlags();
        expect(flags.adminUI).toBe(false);
      });
    });
  });

  describe("isAdminUIEnabled", () => {
    it("returns false when admin UI is disabled", () => {
      process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI = "false";
      expect(isAdminUIEnabled()).toBe(false);
    });

    it("returns true when admin UI is enabled", () => {
      process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI = "true";
      expect(isAdminUIEnabled()).toBe(true);
    });

    it("returns false by default", () => {
      delete process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI;
      expect(isAdminUIEnabled()).toBe(false);
    });
  });

  describe("isFeatureEnabled", () => {
    it("returns correct value for adminUI feature", () => {
      process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI = "true";
      expect(isFeatureEnabled("adminUI")).toBe(true);
    });

    it("returns false for disabled feature", () => {
      process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI = "false";
      expect(isFeatureEnabled("adminUI")).toBe(false);
    });
  });

  describe("Safety - fail-safe defaults", () => {
    it("resolves every flag to its catalog fail-safe default when env vars are unset", () => {
      delete process.env.NEXT_PUBLIC_ENABLE_ADMIN_UI;
      delete process.env.NEXT_PUBLIC_ENABLE_CLAWBACK_UI;
      delete process.env.NEXT_PUBLIC_ENABLE_ADVANCED_REPORTING;
      delete process.env.NEXT_PUBLIC_DISABLE_OFFLINE_BANNER;
      delete process.env.NEXT_PUBLIC_ENABLE_TRADE_WIZARD_V2;
      const flags = getFeatureFlags();

      // Every flag must fall back to the catalog's fail-safe: UI flags are OFF
      // until explicitly enabled, kill-switch flags are ON unless disabled.
      expect(flags).toEqual(FLAG_CATALOG);
    });
  });
});
