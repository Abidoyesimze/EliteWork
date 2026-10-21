#!/usr/bin/env node
/**
 * lighthouse-summary.mjs
 *
 * Renders the Lighthouse CI results of every audited page as a markdown table
 * for the GitHub Actions job summary.
 *
 * Usage:
 *   node scripts/lighthouse-summary.mjs \
 *     --dir .lighthouseci \
 *     --page trades-create:/trades/create \
 *     --page dashboard:/dashboard \
 *     --page vault:/vault
 *
 * Each `--page` takes `<key>:<path>`; the key is the directory LHCI wrote to
 * (`<dir>/<key>/manifest.json`) and the path is the audited route.
 *
 * Exit codes:
 *   0 — table rendered (a page without results is reported as missing)
 *   1 — script error (unreadable manifest)
 */

import { readFileSync, existsSync, appendFileSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";

const METRICS = [
  { label: "Performance", category: "performance", format: "percent" },
  { label: "Accessibility", category: "accessibility", format: "percent" },
  {
    label: "LCP (ms)",
    audit: "largest-contentful-paint",
    format: "ms",
    budget: "≤ 2500",
  },
  {
    label: "TBT (ms)",
    audit: "total-blocking-time",
    format: "ms",
    budget: "≤ 400 (warn)",
  },
  {
    label: "CLS",
    audit: "cumulative-layout-shift",
    format: "raw",
    budget: "≤ 0.02",
  },
  {
    label: "FCP (ms)",
    audit: "first-contentful-paint",
    format: "ms",
    budget: "≤ 1800 (warn)",
  },
];

export function parseArgs(argv) {
  const args = { dir: ".lighthouseci", pages: [] };

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dir") {
      args.dir = argv[++i];
    } else if (argv[i] === "--page") {
      const raw = argv[++i];
      const separator = raw.indexOf(":");
      if (separator === -1) {
        throw new Error(`--page expects "<key>:<path>", got "${raw}"`);
      }
      args.pages.push({
        key: raw.slice(0, separator),
        path: raw.slice(separator + 1),
      });
    }
  }

  if (args.pages.length === 0) {
    throw new Error("at least one --page is required");
  }

  return args;
}

export function readRepresentativeRun(baseDir, key) {
  const manifestPath = join(baseDir, key, "manifest.json");
  if (!existsSync(manifestPath)) return null;

  const runs = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(runs) || runs.length === 0) return null;

  const representative = runs.find((r) => r.isRepresentativeRun) ?? runs[0];
  if (!representative?.jsonPath) return null;

  const lhr = JSON.parse(readFileSync(representative.jsonPath, "utf8"));
  return { lhr, runCount: runs.length };
}

export function formatValue(metric, lhr) {
  if (metric.category) {
    const score = lhr.categories?.[metric.category]?.score;
    return score === null || score === undefined
      ? "n/a"
      : Math.round(score * 100).toString();
  }

  const audit = lhr.audits?.[metric.audit];
  if (!audit || audit.numericValue === undefined) return "n/a";

  switch (metric.format) {
    case "ms":
      return Math.round(audit.numericValue).toString();
    case "raw":
      return audit.numericValue.toFixed(3);
    default:
      return String(audit.numericValue);
  }
}

export function renderTable(results) {
  const header = [
    "| Page | Runs | " + METRICS.map((m) => m.label).join(" | ") + " |",
    "|" + "---|".repeat(METRICS.length + 2),
  ];

  const rows = results.map(({ page, runCount, values }) => {
    const cells = METRICS.map((metric, index) => values[index] ?? "n/a");
    return `| \`${page}\` | ${runCount} | ${cells.join(" | ")} |`;
  });

  return [...header, ...rows].join("\n");
}

export function renderBudgets() {
  const lines = [
    "",
    "Budgets: Performance ≥ 80, Accessibility ≥ 95, LCP ≤ 2500 ms, TBT ≤ 400 ms (warn), CLS ≤ 0.02, FCP ≤ 1800 ms (warn).",
  ];
  return lines.join("\n");
}

export function main(argv = process.argv) {
  const args = parseArgs(argv);
  const baseDir = resolve(args.dir);

  const results = [];
  const missing = [];

  for (const page of args.pages) {
    const run = readRepresentativeRun(baseDir, page.key);
    if (!run) {
      missing.push(page.path);
      results.push({
        page: page.path,
        runCount: 0,
        values: METRICS.map(() => "n/a"),
      });
      continue;
    }

    results.push({
      page: page.path,
      runCount: run.runCount,
      values: METRICS.map((metric) => formatValue(metric, run.lhr)),
    });
  }

  const md = [
    "### Lighthouse — critical pages (median of N runs)",
    "",
    renderTable(results),
    renderBudgets(),
  ].join("\n");

  console.log(md);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }

  if (missing.length > 0) {
    console.warn(
      `[lighthouse-summary] No Lighthouse results found for: ${missing.join(", ")}`,
    );
  }
}

// Only run the CLI when executed directly — the helpers above are imported by
// scripts/__tests__/lighthouse-summary.test.mjs.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
