/**
 * Tests for scripts/verify-test-determinism.sh (issue #335).
 *
 * The script is the authoritative determinism gate for the contract test
 * suite: it runs `cargo test` N times and fails when a run fails or when the
 * "test result:" summaries differ between runs. A bug in the script itself
 * (for example comparing the wrong files, or always exiting 0) would silently
 * disable the gate it enforces, so these tests execute the real script and
 * assert on its exit code and output for both the passing and the failing
 * branches.
 *
 * The script derives its contract directory from its own location
 * (`<script dir>/../contracts/amana_escrow`) and shells out to `cargo`, so
 * each test copies the committed script into a temporary tree and puts a fake
 * `cargo` on PATH. The code under test is byte-identical to the committed
 * script, and the fake `cargo` only stands in for the Rust toolchain — the
 * run loop, the summary comparison and the exit codes are all exercised for
 * real.
 */

import { spawnSync } from "child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { delimiter, dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, "..");
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const SCRIPT = join(SCRIPTS_DIR, "verify-test-determinism.sh");
const DETERMINISM_DOC = join(
  REPO_ROOT,
  "contracts",
  "amana_escrow",
  "docs",
  "test-determinism.md",
);

/**
 * Stand-in for `cargo`. The mode selects the behaviour:
 *   ok    — every run prints the same "test result:" summary (deterministic)
 *   flaky — every run prints a different summary (simulates non-determinism)
 *   fail  — the run fails with a non-zero exit code
 *   fail-after-first — the first run passes, every later run fails
 */
const FAKE_CARGO = [
  "#!/usr/bin/env bash",
  "set -u",
  'STATE_FILE="${FAKE_CARGO_STATE:?FAKE_CARGO_STATE must be set}"',
  "COUNT=0",
  'if [ -f "$STATE_FILE" ]; then',
  '  COUNT="$(cat "$STATE_FILE")"',
  "fi",
  'COUNT=$((COUNT + 1))',
  'printf "%s" "$COUNT" > "$STATE_FILE"',
  'case "${FAKE_CARGO_MODE:-ok}" in',
  "  fail)",
  '    echo "running 5 tests"',
  '    echo "test result: FAILED. 4 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"',
  '    echo "error: 1 test failed" >&2',
  "    exit 101",
  "    ;;",
  "  fail-after-first)",
  '    echo "running 5 tests"',
  '    if [ "$COUNT" -gt 1 ]; then',
  '      echo "test result: FAILED. 4 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"',
  '      echo "error: 1 test failed" >&2',
  "      exit 101",
  "    fi",
  '    echo "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"',
  "    exit 0",
  "    ;;",
  "  flaky)",
  '    echo "running 5 tests"',
  '    echo "test result: ok. $COUNT passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"',
  "    exit 0",
  "    ;;",
  "  *)",
  '    echo "running 5 tests"',
  '    echo "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"',
  "    exit 0",
  "    ;;",
  "esac",
  "",
].join("\n");

/**
 * Runs the real determinism script against the fake `cargo`.
 *
 * @param {{mode?: string, repeat?: number, contractDir?: boolean}} options
 * @returns {{status: number|null, stdout: string, stderr: string, invocations: number}}
 */
function runDeterminism({
  mode = "ok",
  repeat = 3,
  contractDir = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "determinism-"));
  try {
    const scriptDir = join(root, "scripts");
    const binDir = join(root, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    if (contractDir) {
      mkdirSync(join(root, "contracts", "amana_escrow"), { recursive: true });
    }

    copyFileSync(SCRIPT, join(scriptDir, "verify-test-determinism.sh"));

    const cargoPath = join(binDir, "cargo");
    writeFileSync(cargoPath, FAKE_CARGO, "utf8");
    chmodSync(cargoPath, 0o755);

    const stateFile = join(root, "cargo-invocations");
    const result = spawnSync(
      "bash",
      [join(scriptDir, "verify-test-determinism.sh"), String(repeat)],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          FAKE_CARGO_MODE: mode,
          FAKE_CARGO_STATE: stateFile,
        },
      },
    );

    const invocations = existsSync(stateFile)
      ? Number(readFileSync(stateFile, "utf8"))
      : 0;

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      invocations,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Script sanity ─────────────────────────────────────────────────────────

describe("verify-test-determinism.sh", () => {
  it("exists", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("passes a bash syntax check", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });

    expect(result.status).toBe(0);
  });

  it("is documented as the authoritative determinism check", () => {
    expect(existsSync(DETERMINISM_DOC)).toBe(true);
    const doc = readFileSync(DETERMINISM_DOC, "utf8");
    expect(doc).toContain("scripts/verify-test-determinism.sh");
  });
});

// ─── Passing branches ──────────────────────────────────────────────────────

describe("verify-test-determinism.sh — passing branches", () => {
  it("exits 0 when every run produces identical results", () => {
    const result = runDeterminism({ mode: "ok", repeat: 3 });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /All 3 runs passed with zero inter-run variance/,
    );
  });

  it("exits 0 for a single run", () => {
    const result = runDeterminism({ mode: "ok", repeat: 1 });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /All 1 runs passed with zero inter-run variance/,
    );
  });

  it("runs the suite the requested number of times", () => {
    const result = runDeterminism({ mode: "ok", repeat: 5 });

    expect(result.status).toBe(0);
    expect(result.invocations).toBe(5);
  });
});

// ─── Failing branches ──────────────────────────────────────────────────────

describe("verify-test-determinism.sh — failing branches", () => {
  it("exits 1 when a run fails", () => {
    const result = runDeterminism({ mode: "fail", repeat: 1 });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Determinism verification FAILED/);
  });

  it("exits 1 when a later run fails", () => {
    const result = runDeterminism({ mode: "fail-after-first", repeat: 3 });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Determinism verification FAILED/);
    expect(result.invocations).toBe(3);
  });

  it("exits 1 when the results vary between runs", () => {
    const result = runDeterminism({ mode: "flaky", repeat: 3 });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Inter-run variance detected/);
    expect(result.stdout).toMatch(/non-deterministic test behavior/i);
  });

  it("points at the determinism runbook when variance is detected", () => {
    const result = runDeterminism({ mode: "flaky", repeat: 2 });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("test-determinism.md");
  });

  it("exits 1 when the contract directory is missing", () => {
    const result = runDeterminism({ mode: "ok", repeat: 1, contractDir: false });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Determinism verification FAILED/);
  });
});
