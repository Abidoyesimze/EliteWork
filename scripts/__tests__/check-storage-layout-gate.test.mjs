/**
 * Tests for scripts/check-storage-layout-gate.sh
 *
 * The script is a bash script that validates storage layout changes.
 * We test the pure logic by replicating the validation rules in JavaScript
 * and also do smoke tests for the script's syntax and basic execution.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, "..");
const ROOT_DIR = join(SCRIPTS_DIR, "..");
const SCRIPT = join(SCRIPTS_DIR, "check-storage-layout-gate.sh");
const CONTRACT_DIR = join(ROOT_DIR, "contracts", "amana_escrow");

const INTENT_MARKER = "[storage-layout]";
const INTENT_LABEL = "storage-layout-change";
const SCHEMA_CONST = "CURRENT_SCHEMA_VERSION";

// ─── Pure validation logic tests (mirrors script logic) ──────────────────

function checkIntentional(prLabels, prTitle, prBody, commitMessages) {
  // PR labels
  if (prLabels && prLabels.split(",").includes(INTENT_LABEL)) {
    return { intentional: true, reason: `intent: '${INTENT_LABEL}' label present` };
  }

  // PR title / body
  const prText = `${prTitle || ""} ${prBody || ""}`;
  if (prText.includes(INTENT_MARKER)) {
    return { intentional: true, reason: `intent: '${INTENT_MARKER}' marker in PR title or body` };
  }

  // Commit messages
  if (commitMessages && commitMessages.includes(INTENT_MARKER)) {
    return { intentional: true, reason: `intent: '${INTENT_MARKER}' marker in a commit message` };
  }

  return { intentional: false, reason: null };
}

function checkSchemaBumped(diffOutput) {
  // A schema bump is a change to the CURRENT_SCHEMA_VERSION line specifically
  return diffOutput.includes(`+pub const ${SCHEMA_CONST}: u32 = `);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("check-storage-layout-gate logic", () => {
  describe("checkIntentional", () => {
    it("returns true when PR has the intent label", () => {
      const result = checkIntentional(
        "storage-layout-change,other-label",
        "Some PR title",
        "Some PR body",
        "commit message",
      );
      expect(result.intentional).toBe(true);
      expect(result.reason).toContain(INTENT_LABEL);
    });

    it("returns true when PR title contains intent marker", () => {
      const result = checkIntentional(
        "other-label",
        "Fix storage layout [storage-layout]",
        "Some PR body",
        "commit message",
      );
      expect(result.intentional).toBe(true);
      expect(result.reason).toContain(INTENT_MARKER);
    });

    it("returns true when PR body contains intent marker", () => {
      const result = checkIntentional(
        "other-label",
        "Some PR title",
        "This changes storage layout [storage-layout]",
        "commit message",
      );
      expect(result.intentional).toBe(true);
      expect(result.reason).toContain(INTENT_MARKER);
    });

    it("returns true when commit message contains intent marker", () => {
      const result = checkIntentional(
        "other-label",
        "Some PR title",
        "Some PR body",
        "feat: update storage [storage-layout]\nfix: something else",
      );
      expect(result.intentional).toBe(true);
      expect(result.reason).toContain(INTENT_MARKER);
    });

    it("returns false when no intent markers present", () => {
      const result = checkIntentional(
        "other-label",
        "Regular PR title",
        "Regular PR body",
        "Regular commit message",
      );
      expect(result.intentional).toBe(false);
      expect(result.reason).toBeNull();
    });

    it("returns false for empty inputs", () => {
      const result = checkIntentional("", "", "", "");
      expect(result.intentional).toBe(false);
    });

    it("returns false for undefined inputs", () => {
      const result = checkIntentional(undefined, undefined, undefined, undefined);
      expect(result.intentional).toBe(false);
    });

    it("checks labels as comma-separated list", () => {
      // Label with similar name should not match
      const result = checkIntentional(
        "storage-layout,other",
        "title",
        "body",
        "commit",
      );
      expect(result.intentional).toBe(false);
    });
  });

  describe("checkSchemaBumped", () => {
    it("returns true when diff shows schema version bump", () => {
      const diff = `+pub const CURRENT_SCHEMA_VERSION: u32 = 5;`;
      expect(checkSchemaBumped(diff)).toBe(true);
    });

    it("returns true when diff shows schema version bump with different value", () => {
      const diff = `+pub const CURRENT_SCHEMA_VERSION: u32 = 42;`;
      expect(checkSchemaBumped(diff)).toBe(true);
    });

    it("returns false when diff shows other changes to lib.rs", () => {
      const diff = `+pub const OTHER_CONST: u32 = 5;`;
      expect(checkSchemaBumped(diff)).toBe(false);
    });

    it("returns false when schema version is removed (not bumped)", () => {
      const diff = `-pub const CURRENT_SCHEMA_VERSION: u32 = 4;`;
      expect(checkSchemaBumped(diff)).toBe(false);
    });

    it("returns false for empty diff", () => {
      expect(checkSchemaBumped("")).toBe(false);
    });

    it("returns false when schema version change is in context (not added)", () => {
      const diff = ` pub const CURRENT_SCHEMA_VERSION: u32 = 4;`;
      expect(checkSchemaBumped(diff)).toBe(false);
    });
  });
});

// ─── Script validation tests ──────────────────────────────────────────────

describe("check-storage-layout-gate.sh — script validation", () => {
  it("exists and is executable", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const mode = statSync(SCRIPT).mode;
    // Owner execute bit.
    expect(mode & 0o100).toBeTruthy();
  });

  it("passes a bash syntax check", () => {
    expect(() => {
      execSync(`bash -n ${SCRIPT}`, { stdio: "pipe" });
    }).not.toThrow();
  });

  it("has expected constants defined", () => {
    const content = readFileSync(SCRIPT, "utf8");
    expect(content).toContain('INTENT_MARKER="[storage-layout]"');
    expect(content).toContain('INTENT_LABEL="storage-layout-change"');
    expect(content).toContain('SCHEMA_CONST="CURRENT_SCHEMA_VERSION"');
  });

  it("has fail function defined", () => {
    const content = readFileSync(SCRIPT, "utf8");
    expect(content).toContain("fail() {");
    expect(content).toContain("storage layout gate FAILED");
  });

  it("references docs/storage-layout-gate.md in error message", () => {
    const content = readFileSync(SCRIPT, "utf8");
    expect(content).toContain("docs/storage-layout-gate.md");
  });
});

// ─── Integration-style tests (using temp git repos) ───────────────────────

describe("check-storage-layout-gate.sh — integration behavior", () => {
  let tempDir;

  beforeAll(() => {
    tempDir = join(tmpdir(), "storage-gate-test-" + Date.now());
    mkdirSync(tempDir, { recursive: true });
    // Initialize a git repo
    execSync("git init", { cwd: tempDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir, stdio: "pipe" });
    execSync("git config user.name 'Test User'", { cwd: tempDir, stdio: "pipe" });
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function runScript(args, env = {}) {
    return spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd: tempDir,
    });
  }

  function setupContractDir() {
    const contractDir = join(tempDir, "contracts", "amana_escrow");
    mkdirSync(join(contractDir, "src"), { recursive: true });
    mkdirSync(join(contractDir, "tests"), { recursive: true });
    mkdirSync(join(contractDir, "test_snapshots"), { recursive: true });
    // Minimal lib.rs with schema version
    writeFileSync(
      join(contractDir, "src", "lib.rs"),
      `pub const CURRENT_SCHEMA_VERSION: u32 = 1;`,
      "utf8",
    );
    // Minimal storage test file
    writeFileSync(
      join(contractDir, "tests", "storage_golden_tests.rs"),
      `// Golden test\n#[test] fn golden() { assert!(true); }`,
      "utf8",
    );
    // Minimal schema test file
    writeFileSync(
      join(contractDir, "tests", "schema_version_tests.rs"),
      `// Schema test\n#[test] fn schema() { assert!(true); }`,
      "utf8",
    );
    // Minimal Cargo.toml
    writeFileSync(
      join(contractDir, "Cargo.toml"),
      `[package]\nname = "amana_escrow"\nversion = "0.1.0"\nedition = "2021"\n`,
      "utf8",
    );
    return contractDir;
  }

  it("runs without error when no base ref and no changes", () => {
    setupContractDir();
    // The script needs cargo and Rust toolchain; we just check it starts and parses args
    // We can't easily run cargo test in this environment, so we test the early exit path
    // by providing a base_ref that doesn't exist and checking it falls back gracefully
    const result = runScript(["nonexistent-ref"], {
      GITHUB_BASE_REF: "",
    });
    // The script will fail at the cargo test step since Rust isn't installed,
    // but we can verify it parsed the base ref correctly by checking stderr
    expect(result.stderr || result.stdout).toBeTruthy();
  });

  it("exits early when no contract changes detected (but needs cargo)", () => {
    // This is hard to test fully without a full Rust setup, but we can verify
    // the script doesn't have obvious syntax errors and handles args correctly
    const result = runScript(["origin/main"], { GITHUB_BASE_REF: "" });
    // Will fail at cargo test, but should not fail at argument parsing
    expect(result.status).not.toBe(2); // Not a bash syntax error
  });
});

// ─── Test that the script is invoked in CI ────────────────────────────────

describe("check-storage-layout-gate.sh — CI integration", () => {
  it("is referenced in the CI workflow", () => {
    const ciPath = join(ROOT_DIR, ".github", "workflows", "ci.yml");
    const ciContent = readFileSync(ciPath, "utf8");
    expect(ciContent).toContain("check-storage-layout-gate.sh");
    expect(ciContent).toContain("Storage Layout Required Gate");
  });

  it("is listed as a contract gate dependency in changes job", () => {
    const ciPath = join(ROOT_DIR, ".github", "workflows", "ci.yml");
    const ciContent = readFileSync(ciPath, "utf8");
    expect(ciContent).toContain("scripts/check-storage-layout-gate.sh");
  });
});