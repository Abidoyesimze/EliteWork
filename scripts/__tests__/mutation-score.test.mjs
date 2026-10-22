/**
 * Tests for scripts/mutation-score.mjs
 *
 * The StrykerJS JSON report (schema 1.0) stores per-mutant results and no
 * score at all — the score has to be derived, which is exactly what the
 * mutation-testing workflow needs to report.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { summariseMutationReport } from "../mutation-score.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../../scripts/mutation-score.mjs");

function makeReport(files) {
  return { schemaVersion: "1.0", files };
}

function makeFile(mutants) {
  return { mutants: mutants.map((status, index) => ({ id: String(index), status })) };
}

describe("summariseMutationReport", () => {
  it("returns null for a report without files", () => {
    const summary = summariseMutationReport({});
    expect(summary.score).toBeNull();
    expect(summary.files).toHaveLength(0);
  });

  it("computes a perfect score when every mutant is killed", () => {
    const summary = summariseMutationReport(
      makeReport({ "src/a.ts": makeFile(["Killed", "Killed"]) }),
    );
    expect(summary.score).toBe(100);
    expect(summary.totals.killed).toBe(2);
  });

  it("computes the score with Stryker's formula (killed / killed + survived)", () => {
    const summary = summariseMutationReport(
      makeReport({ "src/a.ts": makeFile(["Killed", "Killed", "Survived"]) }),
    );
    expect(summary.score).toBeCloseTo((2 / 3) * 100, 5);
  });

  it("counts mutants without coverage as undetected", () => {
    const summary = summariseMutationReport(
      makeReport({ "src/a.ts": makeFile(["Killed", "NoCoverage"]) }),
    );
    expect(summary.score).toBe(50);
    expect(summary.totals.noCoverage).toBe(1);
  });

  it("counts timeouts as detected", () => {
    const summary = summariseMutationReport(
      makeReport({ "src/a.ts": makeFile(["Killed", "Timeout"]) }),
    );
    expect(summary.score).toBe(100);
    expect(summary.totals.timeout).toBe(1);
  });

  it("excludes ignored mutants from the score but counts them in the total", () => {
    const summary = summariseMutationReport(
      makeReport({ "src/a.ts": makeFile(["Killed", "Ignored"]) }),
    );
    expect(summary.score).toBe(100);
    expect(summary.totals.ignored).toBe(1);
    expect(summary.totals.total).toBe(2);
  });

  it("reports a score per file and combined", () => {
    const summary = summariseMutationReport(
      makeReport({
        "src/a.ts": makeFile(["Killed", "Killed"]),
        "src/b.ts": makeFile(["Killed", "Survived"]),
      }),
    );
    expect(summary.files).toHaveLength(2);
    expect(summary.files.find((f) => f.file === "src/a.ts").score).toBe(100);
    expect(summary.files.find((f) => f.file === "src/b.ts").score).toBe(50);
    expect(summary.score).toBe(75);
  });
});

describe("mutation-score.mjs — CLI", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mutation-score-"));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("prints the score and exits 0 above the threshold", () => {
    const reportPath = join(dir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify(makeReport({ "src/a.ts": makeFile(["Killed", "Killed"]) })),
      "utf8",
    );

    const stdout = execFileSync(
      "node",
      [SCRIPT, "--report", reportPath, "--threshold", "70"],
      { encoding: "utf8" },
    );

    expect(stdout).toContain("100.00%");
  });

  it("exits 1 when the score is below the threshold", () => {
    const reportPath = join(dir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify(makeReport({ "src/a.ts": makeFile(["Survived"]) })),
      "utf8",
    );

    let status = 0;
    try {
      execFileSync("node", [SCRIPT, "--report", reportPath, "--threshold", "70"], {
        stdio: "pipe",
      });
    } catch (err) {
      status = err.status;
    }

    expect(status).toBe(1);
  });

  it("exits 2 when the report is missing", () => {
    let status = 0;
    try {
      execFileSync("node", [SCRIPT, "--report", join(dir, "nope.json")], {
        stdio: "pipe",
      });
    } catch (err) {
      status = err.status;
    }

    expect(status).toBe(2);
  });
});
