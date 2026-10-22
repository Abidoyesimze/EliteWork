/**
 * Tests for scripts/validate-flaky-quarantine.mjs (issue #334).
 *
 * The script is a CI gate: the `validate-quarantine` job in ci.yml runs it on
 * every push and PR, and the `flaky-report.yml` workflow runs it too. A bug
 * *in the script itself* (for example always exiting 0) would silently
 * disable the gate it enforces, so these tests execute the real script and
 * assert on its exit code and output for both the passing and the failing
 * branches.
 *
 * The rules are deliberately NOT re-implemented here. A mirrored copy of the
 * validation logic can drift from the script and keep passing while the
 * script is broken — the exact failure mode this file exists to prevent.
 *
 * The script resolves the registry relative to its own location
 * (`<script dir>/../.github/flaky-tests-quarantine.json`), so each test copies
 * the committed script into a temporary tree and drops the fixture registry at
 * that exact relative path. The code under test is byte-identical to the
 * committed script.
 */

import { spawnSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, "..");
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const SCRIPT = join(SCRIPTS_DIR, "validate-flaky-quarantine.mjs");
const REAL_REGISTRY = join(REPO_ROOT, ".github", "flaky-tests-quarantine.json");

const ALLOWED_SCOPES = ["frontend", "backend", "contracts", "e2e", "other"];
const REQUIRED_FIELDS = [
  "owner",
  "expires_on",
  "scope",
  "pattern",
  "reason",
  "mitigation",
];

/** ISO date (YYYY-MM-DD) `offsetDays` away from today. */
function isoDate(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const FUTURE = isoDate(14);
const PAST = isoDate(-1);

const VALID_ENTRY = {
  owner: "test-user",
  expires_on: FUTURE,
  scope: "frontend",
  pattern: "src/components/Foo.test.tsx",
  reason: "Async race — #42",
  mitigation: "retryTimes(1)",
};

/**
 * Runs the real validator against a fixture registry.
 *
 * @param {unknown[]|string|undefined} registry
 *   Array of entries -> written as `{ version, entries }`.
 *   String           -> written verbatim (used for malformed JSON).
 *   `undefined`      -> the registry file is not created at all.
 * @param {string[]} args extra CLI arguments for the script.
 */
function runValidator(registry, args = []) {
  const root = mkdtempSync(join(tmpdir(), "flaky-quarantine-"));
  try {
    const scriptDir = join(root, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    copyFileSync(SCRIPT, join(scriptDir, "validate-flaky-quarantine.mjs"));

    if (registry !== undefined) {
      const githubDir = join(root, ".github");
      mkdirSync(githubDir, { recursive: true });
      const body =
        typeof registry === "string"
          ? registry
          : JSON.stringify({ version: "1", entries: registry }, null, 2);
      writeFileSync(
        join(githubDir, "flaky-tests-quarantine.json"),
        body,
        "utf8",
      );
    }

    const result = spawnSync(
      process.execPath,
      [join(scriptDir, "validate-flaky-quarantine.mjs"), ...args],
      { encoding: "utf8" },
    );

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Passing branches ──────────────────────────────────────────────────────

describe("validate-flaky-quarantine.mjs — passing branches", () => {
  it("exits 0 for a registry with no entries", () => {
    const result = runValidator([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK — 0 quarantine entries validated/);
  });

  it("exits 0 for a fully populated valid entry", () => {
    const result = runValidator([VALID_ENTRY]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK — 1 quarantine entry validated/);
  });

  it.each(ALLOWED_SCOPES)("accepts the %s scope", (scope) => {
    const result = runValidator([{ ...VALID_ENTRY, scope }]);

    expect(result.status).toBe(0);
  });

  it("exits 0 when every entry is valid", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ...VALID_ENTRY,
      pattern: `src/test-${i}.test.ts`,
    }));

    const result = runValidator(entries);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK — 5 quarantine entries validated/);
  });
});

// ─── Failing branches ──────────────────────────────────────────────────────

describe("validate-flaky-quarantine.mjs — failing branches", () => {
  it.each(REQUIRED_FIELDS)('fails when "%s" is missing', (field) => {
    const entry = { ...VALID_ENTRY };
    delete entry[field];

    const result = runValidator([entry]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing required field "${field}"`);
  });

  it("fails when expires_on is not in YYYY-MM-DD format", () => {
    const result = runValidator([{ ...VALID_ENTRY, expires_on: "12/31/2099" }]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is not YYYY-MM-DD format/);
  });

  it("fails when expires_on is an ISO datetime instead of a date", () => {
    const result = runValidator([
      { ...VALID_ENTRY, expires_on: "2099-12-31T00:00:00Z" },
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is not YYYY-MM-DD format/);
  });

  it("fails when expires_on is not a real calendar date", () => {
    // Month 13 is rejected outright by the date parser, unlike an
    // out-of-range day (e.g. 2099-02-30), which JavaScript silently rolls
    // over into the following month.
    const result = runValidator([{ ...VALID_ENTRY, expires_on: "2099-13-01" }]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is not a valid date/);
  });

  it("fails when an entry has expired", () => {
    const result = runValidator([{ ...VALID_ENTRY, expires_on: PAST }]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is in the past/);
    expect(result.stderr).toMatch(/FAILED — 1 error\(s\) found/);
  });

  it("fails when scope is not an allowed value", () => {
    const result = runValidator([{ ...VALID_ENTRY, scope: "mobile" }]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /scope "mobile" is not one of \[frontend, backend, contracts, e2e, other\]/,
    );
  });

  it("reports every error it finds, not just the first", () => {
    const result = runValidator([
      { ...VALID_ENTRY, expires_on: PAST },
      { ...VALID_ENTRY, scope: "unknown" },
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is in the past/);
    expect(result.stderr).toMatch(/scope "unknown" is not one of/);
    expect(result.stderr).toMatch(/FAILED — 2 error\(s\) found/);
  });

  it("fails when the registry file is missing", () => {
    const result = runValidator(undefined);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot read registry/);
  });

  it("fails when the registry is not valid JSON", () => {
    const result = runValidator("{ not json ");

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot read registry/);
  });

  it("fails when registry.entries is not an array", () => {
    const result = runValidator('{"version":"1","entries":{"a":1}}');

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/registry\.entries must be an array/);
  });
});

// ─── --allow-expired branch ────────────────────────────────────────────────

describe("validate-flaky-quarantine.mjs — --allow-expired", () => {
  it("downgrades an expired entry to a warning and exits 0", () => {
    const result = runValidator([{ ...VALID_ENTRY, expires_on: PAST }], [
      "--allow-expired",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/WARNINGS:/);
    expect(result.stderr).toMatch(/is in the past/);
    expect(result.stdout).toMatch(/OK — 1 quarantine entry validated/);
  });

  it("still fails on non-expiry errors with --allow-expired", () => {
    const result = runValidator([{ ...VALID_ENTRY, scope: "mobile" }], [
      "--allow-expired",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/scope "mobile" is not one of/);
  });
});

// ─── The registry that actually gates CI ───────────────────────────────────

describe("validate-flaky-quarantine.mjs — committed registry", () => {
  it("has a registry file to validate", () => {
    expect(existsSync(REAL_REGISTRY)).toBe(true);
  });

  it("passes for the registry committed to the repository", () => {
    // Runs the committed script with its default registry path — the exact
    // invocation CI performs.
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\[flaky-quarantine\] OK/);
  });
});
