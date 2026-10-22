/**
 * End-to-end tests for scripts/check-admin-test-coverage.sh
 *
 * The script is a CI gate: it diffs HEAD against a base ref and fails
 * (exit 1) when admin source files change without a matching change under
 * backend/src/__tests__/. We exercise it in throwaway git repos so both
 * the pass and fail branches are covered — a bug in the script itself must
 * not silently disable the gate it enforces.
 *
 * Run: pnpm test:scripts
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Resolve relative to this test file — process.cwd() depends on where Jest is
// invoked from (and would point outside the repo when run from the root).
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "check-admin-test-coverage.sh");
const ROOTS = [];

function shellQuote(arg) {
  return /^[A-Za-z0-9_,./:=\-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function git(repoDir, ...args) {
  return execSync(`git ${args.map(shellQuote).join(" ")}`, {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf8",
  });
}

function makeRepo(name) {
  const repoDir = join(tmpdir(), `admin-coverage-test-${Date.now()}-${name}`);
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-q");
  git(repoDir, "config", "user.email", "test@example.com");
  git(repoDir, "config", "user.name", "Test");
  writeFileSync(join(repoDir, "README.md"), "hello\n", "utf8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-q", "-m", "initial");
  ROOTS.push(repoDir);
  return repoDir;
}

function commitFiles(repoDir, files, message) {
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(repoDir, relativePath);
    mkdirSync(join(repoDir, dirnamePosix(relativePath)), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", message);
}

function dirnamePosix(relativePath) {
  const lastSlash = relativePath.lastIndexOf("/");
  return lastSlash === -1 ? "." : relativePath.slice(0, lastSlash);
}

/**
 * Run the gate script against `repoDir` with `HEAD~1` as base ref (the
 * fallback the script itself uses when there is no origin/main). Returns
 * stdout on exit 0; throws with `err.status` set on non-zero exit.
 */
function runGate(repoDir, baseRef = "HEAD~1") {
  return execSync(`bash "${SCRIPT}" ${baseRef}`, {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf8",
  });
}

function runGateExpecting(repoDir, expectedCode, baseRef = "HEAD~1") {
  try {
    const stdout = runGate(repoDir, baseRef);
    if (expectedCode !== 0) {
      throw new Error(
        `expected exit ${expectedCode} but script exited 0:\n${stdout}`,
      );
    }
    return stdout;
  } catch (err) {
    if (expectedCode === 0) {
      throw new Error(
        `expected exit 0 but script exited ${err.status}:\n${err.stderr}\n${err.stdout}`,
      );
    }
    if (err.status !== expectedCode) {
      throw new Error(
        `expected exit ${expectedCode} but got ${err.status}:\n${err.stderr}\n${err.stdout}`,
      );
    }
    return err.stderr + err.stdout;
  }
}

afterAll(() => {
  for (const dir of ROOTS) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/check-admin-test-coverage.sh", () => {
  describe("pass branch (exit 0)", () => {
    it("passes when nothing changed since base ref", () => {
      const repoDir = makeRepo("no-changes");
      // Empty commit: no file changes at all → early exit 0.
      git(repoDir, "commit", "-q", "--allow-empty", "-m", "empty");
      const out = runGateExpecting(repoDir, 0);
      expect(out).toContain("No file changes detected");
    });

    it("passes when only non-admin files change", () => {
      const repoDir = makeRepo("non-admin-only");
      commitFiles(
        repoDir,
        {
          "backend/src/routes/public/trades.ts": "export {}\n",
          "frontend/app/page.tsx": "export {}\n",
        },
        "add non-admin files",
      );
      const out = runGateExpecting(repoDir, 0);
      expect(out).toContain("No admin endpoint or service source files modified");
    });

    it("passes when admin source change is paired with a test change", () => {
      const repoDir = makeRepo("admin-plus-test");
      commitFiles(
        repoDir,
        {
          "backend/src/routes/admin/clawback.ts": "export {}\n",
          "backend/src/__tests__/admin.clawback.test.ts": "test('x', () => {})\n",
        },
        "add admin route with matching test",
      );
      const out = runGateExpecting(repoDir, 0);
      expect(out).toContain("CI Admin Regression Test Policy passed");
      expect(out).toContain("backend/src/__tests__/admin.clawback.test.ts");
    });
  });

  describe("fail branch (exit 1)", () => {
    it("fails when admin source changes without a test change", () => {
      const repoDir = makeRepo("admin-without-test");
      commitFiles(
        repoDir,
        {
          "backend/src/services/admin/feature-flags.service.ts": "export {}\n",
        },
        "add admin service without test",
      );
      const out = runGateExpecting(repoDir, 1);
      expect(out).toContain("POLICY VIOLATION");
      expect(out).toContain("backend/src/services/admin/feature-flags.service.ts");
    });

    it("fails for any admin path prefix (routes/controllers/middleware/services)", () => {
      for (const adminPath of [
        "backend/src/middleware/admin/auth.ts",
        "backend/src/controllers/admin/users.controller.ts",
      ]) {
        const repoDir = makeRepo("admin-prefix");
        commitFiles(repoDir, { [adminPath]: "export {}\n" }, "add admin file");
        runGateExpecting(repoDir, 1);
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
