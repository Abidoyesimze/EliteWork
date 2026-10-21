/**
 * Tests for scripts/check-schema-parity.mjs
 *
 * CI runs `node scripts/check-schema-parity.mjs` and expects exit 0 only
 * when the backend and frontend domain schema files are byte-identical
 * (modulo the leading doc comment). We exercise the real script against the
 * real schema pair (pass branch, read-only) plus patched temp copies that
 * make the pair identical or diverged (pass/fail branches) — so a bug in
 * the script itself cannot silently disable the gate.
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
const SCRIPT = join(__dirname, "..", "check-schema-parity.mjs");
const ROOTS = [];

const SCHEMA_HEAD = `import { z } from "zod";

export const tradeSchema = z.object({});
`;

function makeParityRun(aContent, bContent) {
  const dir = join(tmpdir(), `schema-parity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  ROOTS.push(dir);

  const script = readFileSync(SCRIPT, "utf8");
  const patched = script
    .replace('"backend/src/schemas/domain/trade.ts"', JSON.stringify(resolve(dir, "a.ts")))
    .replace('"frontend/src/lib/domain-schemas/trade.ts"', JSON.stringify(resolve(dir, "b.ts")));
  if (patched === script) {
    throw new Error("failed to patch schema paths in check-schema-parity.mjs copy");
  }
  writeFileSync(join(dir, "parity-check.mjs"), patched, "utf8");
  writeFileSync(join(dir, "a.ts"), aContent, "utf8");
  writeFileSync(join(dir, "b.ts"), bContent, "utf8");

  return {
    dir,
    run() {
      try {
        execSync(`node "${join(dir, "parity-check.mjs")}"`, {
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

describe("scripts/check-schema-parity.mjs", () => {
  describe("pass branch (exit 0)", () => {
    it("passes against the real backend/frontend schema pair (read-only smoke test)", () => {
      try {
        execSync(`node "${SCRIPT}"`, {
          stdio: "pipe",
          encoding: "utf8",
        });
      } catch (err) {
        throw new Error(
          `real schema pair should be in sync (exit 0), got ${err.status ?? -1}: ${err.stderr}`,
        );
      }
    });

    it("passes when the patched pair is identical", () => {
      const { run } = makeParityRun(SCHEMA_HEAD, SCHEMA_HEAD);
      expect(run().code).toBe(0);
    });

    it("passes when the bodies match despite different leading comments", () => {
      const a = "// backend mirror\n" + SCHEMA_HEAD;
      const b = "// frontend canonical\n" + SCHEMA_HEAD;
      const { run } = makeParityRun(a, b);
      expect(run().code).toBe(0);
    });
  });

  describe("fail branch (exit 1)", () => {
    it("fails when the pair has diverged", () => {
      const { run } = makeParityRun(SCHEMA_HEAD, SCHEMA_HEAD.replace("tradeSchema", "otherSchema"));
      const result = run();
      expect(result.code).toBe(1);
      expect(String(result.stderr + result.stdout)).toContain("diverged");
    });

    it("fails when one side is missing the zod anchor", () => {
      const { run } = makeParityRun("export const x = 1;\n", SCHEMA_HEAD);
      expect(run().code).toBe(1);
    });
  });
});
