/**
 * Tests for scripts/lighthouse-summary.mjs
 *
 * The workflow renders a per-page score table from the manifests that
 * Lighthouse CI writes with the `filesystem` upload target
 * (`<dir>/<page>/manifest.json`).
 */

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  parseArgs,
  readRepresentativeRun,
  formatValue,
  renderTable,
  main,
} from "../lighthouse-summary.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../../scripts/lighthouse-summary.mjs");

function makeLhr({ performance = 0.9, accessibility = 0.98 } = {}) {
  return {
    categories: {
      performance: { score: performance },
      accessibility: { score: accessibility },
    },
    audits: {
      "largest-contentful-paint": { numericValue: 1234.5 },
      "total-blocking-time": { numericValue: 120 },
      "cumulative-layout-shift": { numericValue: 0.004 },
      "first-contentful-paint": { numericValue: 900 },
    },
  };
}

/**
 * Writes a `<dir>/<key>/manifest.json` plus the referenced LHR files.
 */
function writeManifest(dir, key, entries) {
  const pageDir = join(dir, key);
  mkdirSync(pageDir, { recursive: true });

  const manifest = entries.map((entry, index) => {
    const jsonPath = join(pageDir, `lhr-${index}.json`);
    writeFileSync(jsonPath, JSON.stringify(entry.lhr), "utf8");
    return {
      url: entry.url ?? "http://localhost:3000/",
      isRepresentativeRun: entry.isRepresentativeRun ?? false,
      jsonPath,
    };
  });

  writeFileSync(
    join(pageDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  return pageDir;
}

describe("parseArgs", () => {
  it("parses --dir and repeated --page arguments", () => {
    const args = parseArgs([
      "node",
      "lighthouse-summary.mjs",
      "--dir",
      "reports/lh",
      "--page",
      "dashboard:/dashboard",
      "--page",
      "vault:/vault",
    ]);

    expect(args.dir).toBe("reports/lh");
    expect(args.pages).toEqual([
      { key: "dashboard", path: "/dashboard" },
      { key: "vault", path: "/vault" },
    ]);
  });

  it("rejects a --page without a key/path separator", () => {
    expect(() =>
      parseArgs(["node", "lighthouse-summary.mjs", "--page", "dashboard"]),
    ).toThrow(/--page expects/);
  });

  it("requires at least one --page", () => {
    expect(() => parseArgs(["node", "lighthouse-summary.mjs"])).toThrow(
      /at least one --page/,
    );
  });
});

describe("readRepresentativeRun", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lighthouse-summary-"));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the page has no manifest", () => {
    expect(readRepresentativeRun(dir, "dashboard")).toBeNull();
  });

  it("picks the representative run, not the first one", () => {
    writeManifest(dir, "dashboard", [
      { lhr: makeLhr({ performance: 0.1 }), isRepresentativeRun: false },
      { lhr: makeLhr({ performance: 0.9 }), isRepresentativeRun: true },
    ]);

    const run = readRepresentativeRun(dir, "dashboard");
    expect(run.runCount).toBe(2);
    expect(run.lhr.categories.performance.score).toBe(0.9);
  });

  it("falls back to the first run when no run is marked representative", () => {
    writeManifest(dir, "vault", [
      { lhr: makeLhr({ accessibility: 0.96 }), isRepresentativeRun: false },
    ]);

    const run = readRepresentativeRun(dir, "vault");
    expect(run.lhr.categories.accessibility.score).toBe(0.96);
  });
});

describe("formatValue", () => {
  it("formats category scores as percentages", () => {
    expect(
      formatValue({ label: "Performance", category: "performance" }, makeLhr()),
    ).toBe("90");
  });

  it("formats millisecond audits as integers", () => {
    expect(
      formatValue(
        { label: "LCP (ms)", audit: "largest-contentful-paint", format: "ms" },
        makeLhr(),
      ),
    ).toBe("1235");
  });

  it("formats the layout shift audit with three decimals", () => {
    expect(
      formatValue(
        { label: "CLS", audit: "cumulative-layout-shift", format: "raw" },
        makeLhr(),
      ),
    ).toBe("0.004");
  });

  it("returns n/a for a missing audit", () => {
    expect(
      formatValue({ label: "CLS", audit: "does-not-exist", format: "raw" }, {
        categories: {},
        audits: {},
      }),
    ).toBe("n/a");
  });
});

describe("renderTable", () => {
  it("renders one row per page with the page path", () => {
    const table = renderTable([
      { page: "/dashboard", runCount: 3, values: ["91", "97", "1200"] },
    ]);

    expect(table).toContain("| Page | Runs |");
    expect(table).toContain("| `/dashboard` | 3 | 91 | 97 | 1200 |");
  });
});

describe("lighthouse-summary.mjs — CLI", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lighthouse-summary-cli-"));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("prints a row for every requested page", () => {
    writeManifest(dir, "dashboard", [
      { lhr: makeLhr(), isRepresentativeRun: true },
    ]);

    const stdout = execFileSync(
      "node",
      [
        SCRIPT,
        "--dir",
        dir,
        "--page",
        "dashboard:/dashboard",
        "--page",
        "vault:/vault",
      ],
      { encoding: "utf8" },
    );

    expect(stdout).toContain("| `/dashboard` | 1 |");
    expect(stdout).toContain("| `/vault` | 0 |");
  });

  it("warns about pages without results but still exits 0", () => {
    const stdout = execFileSync(
      "node",
      [SCRIPT, "--dir", dir, "--page", "vault:/vault"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(stdout).toContain("/vault");
  });

  it("appends the table to GITHUB_STEP_SUMMARY when set", () => {
    writeManifest(dir, "dashboard", [
      { lhr: makeLhr(), isRepresentativeRun: true },
    ]);

    const summaryFile = join(dir, "summary.md");
    writeFileSync(summaryFile, "", "utf8");

    const previous = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    try {
      main(["node", "lighthouse-summary.mjs", "--dir", dir, "--page", "dashboard:/dashboard"]);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = previous;
    }

    const written = execFileSync("cat", [summaryFile], { encoding: "utf8" });
    expect(written).toContain("| `/dashboard` | 1 |");
  });
});
