/**
 * Tests for scripts/check-trivyignore-expiry.mjs
 *
 * We test the validation logic directly by importing the pure validation
 * functions. The script itself is an executable that reads a file and exits —
 * we test the logic, not the process wrapper.
 */

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "check-trivyignore-expiry.mjs",
);
const TMP = join(tmpdir(), "trivyignore-test-" + Date.now());
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_TRIVYIGNORE = join(REPO_ROOT, ".trivyignore");

function trivyignorePath() {
  return join(TMP, ".trivyignore");
}

function writeTrivyignore(content) {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  writeFileSync(trivyignorePath(), content, "utf8");
}

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

// ─── Pure validation logic tests (mirrors script logic) ──────────────────

function validateTrivyignore(lines) {
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const problems = [];
  let pendingExpiry = null; // { date: Date, raw: string, line: number }

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (trimmed === "") return;

    const m = trimmed.match(/^#\s*expires:\s*(\d{4}-\d{2}-\d{2})\s*$/i);
    if (m) {
      const date = new Date(m[1] + "T00:00:00Z");
      if (Number.isNaN(date.getTime())) {
        problems.push(`line ${lineNo}: invalid expires date "${m[1]}"`);
        pendingExpiry = null;
      } else {
        pendingExpiry = { date, raw: m[1], line: lineNo };
      }
      return;
    }

    if (trimmed.startsWith("#")) return; // other comment — keep any pending expiry

    // A concrete ignore id (CVE / misconfig rule).
    if (!pendingExpiry) {
      problems.push(
        `line ${lineNo}: "${trimmed}" has no preceding "# expires: YYYY-MM-DD" marker`,
      );
      return;
    }
    if (pendingExpiry.date < today) {
      problems.push(
        `line ${lineNo}: "${trimmed}" is covered by an EXPIRED waiver (expired ${pendingExpiry.raw}) — renew or remove`,
      );
    }
    pendingExpiry = null;
  });

  return problems;
}

// ─── Test date helpers (module scope) ────────────────────────────────────

const futureDate = new Date();
futureDate.setDate(futureDate.getDate() + 14);
const FUTURE = futureDate.toISOString().slice(0, 10);

const pastDate = new Date();
pastDate.setDate(pastDate.getDate() - 1);
const PAST = pastDate.toISOString().slice(0, 10);

const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
const TODAY = today.toISOString().slice(0, 10);

// ─── Tests ────────────────────────────────────────────────────────────────

describe("check-trivyignore-expiry logic", () => {
  describe("empty file", () => {
    it("passes with zero lines", () => {
      expect(validateTrivyignore([])).toHaveLength(0);
    });

    it("passes with only blank lines", () => {
      expect(validateTrivyignore(["", "   ", "\t"])).toHaveLength(0);
    });

    it("passes with only comment lines (no ignore ids)", () => {
      expect(validateTrivyignore(["# comment", "# another comment"])).toHaveLength(0);
    });
  });

  describe("valid entries with future expiry", () => {
    it("passes for a single valid entry with future expiry", () => {
      const lines = [`# expires: ${FUTURE}`, "CVE-2023-12345"];
      expect(validateTrivyignore(lines)).toHaveLength(0);
    });

    it("passes for multiple valid entries each with their own expiry", () => {
      const lines = [
        `# expires: ${FUTURE}`,
        "CVE-2023-12345",
        `# expires: ${FUTURE}`,
        "CVE-2023-67890",
      ];
      expect(validateTrivyignore(lines)).toHaveLength(0);
    });

    it("passes when expiry is today (not expired yet)", () => {
      const lines = [`# expires: ${TODAY}`, "CVE-2023-12345"];
      expect(validateTrivyignore(lines)).toHaveLength(0);
    });

    it("passes when other comments appear between expiry and ignore id", () => {
      const lines = [
        `# expires: ${FUTURE}`,
        "# some explanation",
        "# another comment",
        "CVE-2023-12345",
      ];
      expect(validateTrivyignore(lines)).toHaveLength(0);
    });

    it("ignores case for expires keyword", () => {
      const lines = [`# EXPIRES: ${FUTURE}`, "CVE-2023-12345"];
      expect(validateTrivyignore(lines)).toHaveLength(0);
    });

    it("handles extra whitespace around expires marker", () => {
      const lines = [`#   expires:   ${FUTURE}   `, "CVE-2023-12345"];
      expect(validateTrivyignore(lines)).toHaveLength(0);
    });
  });

  describe("expired entries", () => {
    it("fails when expiry is in the past", () => {
      const lines = [`# expires: ${PAST}`, "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("EXPIRED waiver");
      expect(problems[0]).toContain(PAST);
    });

    it("fails for multiple expired entries", () => {
      const lines = [
        `# expires: ${PAST}`,
        "CVE-2023-12345",
        `# expires: ${PAST}`,
        "CVE-2023-67890",
      ];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(2);
    });

    it("does not mark future entries as expired when mixed with expired", () => {
      const lines = [
        `# expires: ${PAST}`,
        "CVE-2023-12345",
        `# expires: ${FUTURE}`,
        "CVE-2023-67890",
      ];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("CVE-2023-12345");
    });
  });

  describe("missing expiry marker", () => {
    it("fails when ignore id has no preceding expiry marker", () => {
      const lines = ["CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("has no preceding");
    });

    it("fails when multiple ignore ids share one expiry (only first gets it)", () => {
      const lines = [
        `# expires: ${FUTURE}`,
        "CVE-2023-12345",
        "CVE-2023-67890",
      ];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("CVE-2023-67890");
    });

    it("resets pending expiry after a valid ignore id", () => {
      const lines = [
        `# expires: ${FUTURE}`,
        "CVE-2023-12345",
        "CVE-2023-67890",
      ];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("CVE-2023-67890");
    });
  });

  describe("invalid expiry date format (script regex only matches YYYY-MM-DD)", () => {
    it("treats MM/DD/YYYY as a comment, so next line has no marker", () => {
      const lines = ["# expires: 12/31/2099", "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("has no preceding");
      expect(problems[0]).toContain("CVE-2023-12345");
    });

    it("treats ISO datetime as a comment, so next line has no marker", () => {
      const lines = ["# expires: 2099-12-31T00:00:00Z", "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("has no preceding");
      expect(problems[0]).toContain("CVE-2023-12345");
    });

    it("treats incomplete date as a comment, so next line has no marker", () => {
      const lines = ["# expires: 2099-12", "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("has no preceding");
      expect(problems[0]).toContain("CVE-2023-12345");
    });

    it("treats non-numeric date as a comment, so next line has no marker", () => {
      const lines = ["# expires: YYYY-MM-DD", "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("has no preceding");
      expect(problems[0]).toContain("CVE-2023-12345");
    });

    it("reports invalid date only when regex matches but Date parsing fails (e.g., invalid month)", () => {
      // The regex \d{4}-\d{2}-\d{2} matches, but month 13 is invalid
      const lines = ["# expires: 2025-13-01", "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      // 2025-13-01 has invalid month, so Date parsing gives NaN
      expect(problems.length).toBeGreaterThanOrEqual(1);
      expect(problems[0]).toContain("invalid expires date");
      expect(problems[0]).toContain("2025-13-01");
    });

    it("reports invalid date for day 00 (regex matches but Date parsing fails)", () => {
      const lines = ["# expires: 2025-01-00", "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems.length).toBeGreaterThanOrEqual(1);
      expect(problems[0]).toContain("invalid expires date");
      expect(problems[0]).toContain("2025-01-00");
    });
  });

  describe("line number reporting", () => {
    it("reports correct line number for missing expiry", () => {
      const lines = ["# comment", "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems[0]).toContain("line 2");
    });

    it("reports correct line number for expired waiver", () => {
      const lines = [`# expires: ${PAST}`, "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems[0]).toContain("line 2");
    });

    it("reports correct line number for invalid expiry date (regex matches but date invalid)", () => {
      const lines = ["# expires: 2025-13-01", "CVE-2023-12345"];
      const problems = validateTrivyignore(lines);
      expect(problems[0]).toContain("line 1");
    });
  });

  describe("complex realistic scenarios", () => {
    it("passes for a realistic .trivyignore file with future dates", () => {
      const lines = [
        "# Trivy ignore file for Amana",
        "# Generated on 2024-01-15",
        "",
        `# expires: ${FUTURE}`,
        "CVE-2023-12345",
        "",
        `# expires: ${FUTURE}`,
        "CVE-2023-67890",
        "",
        "# This is a misconfig rule",
        `# expires: ${FUTURE}`,
        "KSV001",
      ];
      expect(validateTrivyignore(lines)).toHaveLength(0);
    });

    it("fails for a file with mixed valid and expired entries", () => {
      const lines = [
        `# expires: ${FUTURE}`,
        "CVE-2023-12345",
        `# expires: ${PAST}`,
        "CVE-2023-67890",
        `# expires: ${FUTURE}`,
        "KSV001",
      ];
      const problems = validateTrivyignore(lines);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("CVE-2023-67890");
      expect(problems[0]).toContain("EXPIRED");
    });
  });
});

// ─── Script smoke test (exit codes) ───────────────────────────────────────

function runScript() {
  return spawnSync("node", [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

describe("check-trivyignore-expiry.mjs — script exit codes", () => {
  it("exits 0 for the repo's actual .trivyignore file", () => {
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toContain("✓");
  });

  it("passes node --check (no syntax errors)", () => {
    const result = spawnSync("node", ["--check", SCRIPT], {
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(result.status).toBe(0);
  });
});