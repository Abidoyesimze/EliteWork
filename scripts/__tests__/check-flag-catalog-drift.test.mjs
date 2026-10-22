/**
 * Tests for scripts/check-flag-catalog-drift.ts
 *
 * CI runs this script (`ts-node --skip-project scripts/check-flag-catalog-drift.ts`)
 * and it must fail when the backend's known flags drift ahead of the frontend
 * FLAG_CATALOG. Since the script reads TypeScript and calls process.exit(),
 * we copy it to a temp `.mts`, override the frontend catalog path to a file we
 * control, and run it with Node's native type stripping — asserting both the
 * pass (in-sync catalogs) and fail (drift / unparseable catalog) branches.
 *
 * The BACKEND_KNOWN_FLAGS list below mirrors scripts/check-flag-catalog-drift.ts
 * and must be kept in sync with it.
 *
 * Run: pnpm test:scripts
 */

import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

// Resolve relative to this test file — process.cwd() depends on where Jest is
// invoked from (and would point outside the repo when run from the root).
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "check-flag-catalog-drift.ts");
const ROOTS = [];

// Mirrors BACKEND_KNOWN_FLAGS in scripts/check-flag-catalog-drift.ts
const BACKEND_KNOWN_FLAGS = ["adminUI", "clawbackUI", "advancedReporting", "offlineBanner", "tradeWizardV2"];

function catalogFile(keys) {
  const listed = keys.map((k) => `  ${k}: false,`).join("\n");
  return `export const FLAG_CATALOG = {\n${listed}\n} as const;\n`;
}

function makeDriftRun(flagsPath) {
  const dir = join(tmpdir(), `flag-drift-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  ROOTS.push(dir);

  const script = readFileSync(SCRIPT, "utf8");
  // The script resolves the frontend catalog relative to __dirname (not
  // defined in ESM) and process.exits on its own. Override the path to a
  // catalog we control and run the copy with native type stripping.
  const patched = script.replace(
    "const frontendFlagsPath = path.resolve(\n  __dirname,\n  '../frontend/src/lib/featureFlags.ts',\n);",
    `const frontendFlagsPath = ${JSON.stringify(resolve(dir, "flags.ts"))};`,
  );
  if (patched === script) {
    throw new Error("failed to patch frontendFlagsPath in check-flag-catalog-drift.ts copy");
  }
  writeFileSync(join(dir, "drift-check.mts"), patched, "utf8");
  writeFileSync(join(dir, "flags.ts"), catalogFile(BACKEND_KNOWN_FLAGS), "utf8");

  return {
    dir,
    run(flagsContent = catalogFile(BACKEND_KNOWN_FLAGS)) {
      writeFileSync(join(dir, "flags.ts"), flagsContent, "utf8");
      try {
        execSync(`node --experimental-strip-types "${join(dir, "drift-check.mts")}"`, {
          stdio: "pipe",
          encoding: "utf8",
        });
        return { code: 0 };
      } catch (err) {
        return { code: err.status ?? -1, stderr: err.stderr, stdout: err.stdout };
      }
    },
  };
}

afterAll(() => {
  for (const dir of ROOTS) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/check-flag-catalog-drift.ts", () => {
  describe("pass branch (exit 0)", () => {
    it("passes when every backend flag is in the frontend catalog", () => {
      const { run } = makeDriftRun();
      expect(run().code).toBe(0);
    });

    it("passes when the frontend catalog has extra env-only flags", () => {
      const { run } = makeDriftRun();
      expect(
        run(catalogFile([...BACKEND_KNOWN_FLAGS, "envOnlyFlag"])).code,
      ).toBe(0);
    });

    it("passes against the real frontend catalog (smoke test)", () => {
      const dir = join(tmpdir(), `flag-drift-real-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      ROOTS.push(dir);
      const script = readFileSync(SCRIPT, "utf8");
      const patched = script.replace(
        "const frontendFlagsPath = path.resolve(\n  __dirname,\n  '../frontend/src/lib/featureFlags.ts',\n);",
        `const frontendFlagsPath = ${JSON.stringify(
          resolve(join(dirname(SCRIPT), "..", "frontend/src/lib/featureFlags.ts")),
        )};`,
      );
      writeFileSync(join(dir, "drift-check.mts"), patched, "utf8");
      try {
        execSync(`node --experimental-strip-types "${join(dir, "drift-check.mts")}"`, {
          stdio: "pipe",
          encoding: "utf8",
        });
      } catch (err) {
        throw new Error(
          `real flag catalog should be in sync (exit 0), got ${err.status ?? -1}: ${err.stderr}`,
        );
      }
    });
  });

  describe("fail branch (exit 1)", () => {
    it("fails when a backend flag is missing from the frontend catalog", () => {
      const { run } = makeDriftRun();
      const missing = "clawbackUI";
      const keys = BACKEND_KNOWN_FLAGS.filter((k) => k !== missing);
      const result = run(catalogFile(keys));
      expect(result.code).toBe(1);
      expect(String(result.stderr + result.stdout)).toContain(missing);
      expect(String(result.stderr + result.stdout)).toContain("MISSING from frontend FLAG_CATALOG");
    });

    it("fails when the frontend catalog cannot be parsed", () => {
      const dir = join(tmpdir(), `flag-drift-bad-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      ROOTS.push(dir);
      const script = readFileSync(SCRIPT, "utf8");
      const patched = script.replace(
        "const frontendFlagsPath = path.resolve(\n  __dirname,\n  '../frontend/src/lib/featureFlags.ts',\n);",
        `const frontendFlagsPath = ${JSON.stringify(resolve(dir, "flags.ts"))};`,
      );
      writeFileSync(join(dir, "drift-check.mts"), patched, "utf8");
      writeFileSync(join(dir, "flags.ts"), "export const FLAG_CATALOG = not valid ;;\n", "utf8");
      try {
        execSync(`node --experimental-strip-types "${join(dir, "drift-check.mts")}"`, {
          stdio: "pipe",
          encoding: "utf8",
        });
        throw new Error("expected exit 1 for unparseable catalog");
      } catch (err) {
        expect(err.status).toBe(1);
      }
    });

    it("fails when the frontend catalog file does not exist", () => {
      const dir = join(tmpdir(), `flag-drift-missing-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      ROOTS.push(dir);
      const script = readFileSync(SCRIPT, "utf8");
      const patched = script.replace(
        "const frontendFlagsPath = path.resolve(\n  __dirname,\n  '../frontend/src/lib/featureFlags.ts',\n);",
        `const frontendFlagsPath = ${JSON.stringify(resolve(dir, "does-not-exist.ts"))};`,
      );
      writeFileSync(join(dir, "drift-check.mts"), patched, "utf8");
      try {
        execSync(`node --experimental-strip-types "${join(dir, "drift-check.mts")}"`, {
          stdio: "pipe",
          encoding: "utf8",
        });
        throw new Error("expected exit 1 for missing catalog");
      } catch (err) {
        expect(err.status).toBe(1);
      }
    });
  });
});
