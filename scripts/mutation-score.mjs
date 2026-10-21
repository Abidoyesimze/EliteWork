#!/usr/bin/env node
/**
 * mutation-score.mjs
 *
 * Reads a StrykerJS JSON report and prints the mutation score.
 *
 * The StrykerJS JSON reporter (schema 1.0) does NOT contain a score field —
 * it stores the per-mutant results, and the score is derived from them with
 * Stryker's own formula:
 *
 *   detected   = killed + timeout
 *   undetected = survived + noCoverage
 *   score      = detected / (detected + undetected) * 100
 *
 * Usage:
 *   node scripts/mutation-score.mjs \
 *     --report backend/reports/mutation/money-math/mutation-report.json \
 *     [--threshold 70]
 *
 * Exit codes:
 *   0 — score computed (and above --threshold when given)
 *   1 — the score is below --threshold
 *   2 — the report could not be read
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

/**
 * Computes Stryker's mutation score from a parsed report.
 *
 * @param {object} report parsed StrykerJS JSON report
 * @returns {{score: number|null, files: object[], totals: object}}
 */
export function summariseMutationReport(report) {
  const files = [];
  const totals = {
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeout: 0,
    ignored: 0,
    runtimeError: 0,
    compileError: 0,
    pending: 0,
    total: 0,
  };

  for (const [file, data] of Object.entries(report?.files ?? {})) {
    const counts = {
      killed: 0,
      survived: 0,
      noCoverage: 0,
      timeout: 0,
      ignored: 0,
      runtimeError: 0,
      compileError: 0,
      pending: 0,
    };

    for (const mutant of data.mutants ?? []) {
      switch (mutant.status) {
        case "Killed":
          counts.killed++;
          break;
        case "Survived":
          counts.survived++;
          break;
        case "NoCoverage":
          counts.noCoverage++;
          break;
        case "Timeout":
          counts.timeout++;
          break;
        case "Ignored":
          counts.ignored++;
          break;
        case "RuntimeError":
          counts.runtimeError++;
          break;
        case "CompileError":
          counts.compileError++;
          break;
        default:
          counts.pending++;
          break;
      }
    }

    const detected = counts.killed + counts.timeout;
    const undetected = counts.survived + counts.noCoverage;
    const valid = detected + undetected;
    const total = valid + counts.ignored + counts.runtimeError + counts.compileError + counts.pending;

    files.push({
      file,
      ...counts,
      total,
      score: valid > 0 ? (detected / valid) * 100 : null,
    });

    for (const key of Object.keys(totals)) {
      totals[key] += counts[key] ?? 0;
    }
    totals.total += total;
  }

  const detected = totals.killed + totals.timeout;
  const undetected = totals.survived + totals.noCoverage;
  const valid = detected + undetected;

  return {
    score: valid > 0 ? (detected / valid) * 100 : null,
    files,
    totals,
  };
}

function formatScore(score) {
  return score === null ? "n/a" : `${score.toFixed(2)}%`;
}

function renderTable(summary) {
  const lines = [
    "| File | Killed | Survived | No coverage | Timeout | Total | Score |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const file of summary.files) {
    lines.push(
      `| \`${file.file}\` | ${file.killed} | ${file.survived} | ${file.noCoverage} | ${file.timeout} | ${file.total} | ${formatScore(file.score)} |`,
    );
  }

  lines.push(
    `| **Combined** | **${summary.totals.killed}** | **${summary.totals.survived}** | **${summary.totals.noCoverage}** | **${summary.totals.timeout}** | **${summary.totals.total}** | **${formatScore(summary.score)}** |`,
  );

  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { report: null, threshold: null };

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--report") {
      args.report = argv[++i];
    } else if (argv[i] === "--threshold") {
      args.threshold = Number(argv[++i]);
    }
  }

  if (!args.report) {
    throw new Error("--report <path> is required");
  }

  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`[mutation-score] ERROR: ${err.message}`);
    process.exit(2);
  }

  const reportPath = resolve(args.report);
  if (!existsSync(reportPath)) {
    console.error(`[mutation-score] ERROR: report not found at ${reportPath}`);
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (err) {
    console.error(`[mutation-score] ERROR: cannot parse ${reportPath}: ${err.message}`);
    process.exit(2);
  }

  const summary = summariseMutationReport(report);

  const md = [
    "## Mutation score",
    "",
    `**${formatScore(summary.score)}** — ${summary.totals.killed} killed, ${summary.totals.survived} survived, ${summary.totals.noCoverage} without coverage, ${summary.totals.timeout} timed out (${summary.totals.total} mutants).`,
    "",
    renderTable(summary),
    "",
    "See `docs/mutation-testing-baseline.md` for the recorded baseline and the triage ritual.",
  ].join("\n");

  console.log(md);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }

  if (args.threshold !== null && summary.score !== null) {
    if (summary.score < args.threshold) {
      console.error(
        `[mutation-score] FAILED — score ${summary.score.toFixed(2)}% is below the ${args.threshold}% floor.`,
      );
      process.exit(1);
    }
    console.log(
      `[mutation-score] OK — score ${summary.score.toFixed(2)}% is at or above the ${args.threshold}% floor.`,
    );
  }
}

// Only run the CLI when executed directly — the pure helpers above are
// imported by scripts/__tests__/mutation-score.test.mjs.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
