#!/usr/bin/env node
/**
 * flake-reporter.mjs
 *
 * Detects flaky test candidates from Jest JSON results and writes a
 * structured flake report.
 *
 * A test is a flake CANDIDATE when:
 *   - Its test result file shows a failed + passed run for the same test name
 *     within the same CI session (pass-after-retry pattern), OR
 *   - It is already present in the quarantine registry (tracked flake).
 *
 * The reporter also records every test FILE it observed (not only the failing
 * ones). The weekly aggregation uses that observation data to decide whether a
 * quarantined test is still flaky or is READY FOR RE-PROMOTION (the mitigation
 * works, the entry should be removed from the registry).
 *
 * Usage (CI):
 *   node scripts/flake-reporter.mjs \
 *     --results   backend/jest-results.json \
 *     --results   frontend/jest-results.json \
 *     --registry  .github/flaky-tests-quarantine.json \
 *     --output    reports/flake/flake-report.json \
 *     --scope     backend \
 *     --scope     frontend
 *
 * Usage (weekly report aggregation):
 *   node scripts/flake-reporter.mjs \
 *     --report-dir reports/flake/ \
 *     --registry .github/flaky-tests-quarantine.json \
 *     --weekly-output reports/flake/weekly-summary.md \
 *     [--fail-on-repromotion]
 *
 * Exit codes:
 *   0 — completed successfully (flakes may exist but are non-blocking)
 *   1 — script error (missing input, parse failure)
 *   2 — weekly mode only: at least one quarantine entry is ready for
 *       re-promotion and --fail-on-repromotion was passed
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── Argument parsing ────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    results: [],
    scopes: [],
    registry: join(ROOT, ".github/flaky-tests-quarantine.json"),
    output: null,
    reportDir: null,
    weeklyOutput: null,
    failOnRepromotion: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--results":
        args.results.push(resolve(ROOT, argv[++i]));
        break;
      case "--registry":
        args.registry = resolve(ROOT, argv[++i]);
        break;
      case "--output":
        args.output = resolve(ROOT, argv[++i]);
        break;
      case "--scope":
        args.scopes.push(argv[++i]);
        break;
      case "--report-dir":
        args.reportDir = resolve(ROOT, argv[++i]);
        break;
      case "--weekly-output":
        args.weeklyOutput = resolve(ROOT, argv[++i]);
        break;
      case "--fail-on-repromotion":
        args.failOnRepromotion = true;
        break;
    }
  }
  return args;
}

// ─── Load quarantine registry ────────────────────────────────────────────────

function loadRegistry(path) {
  if (!existsSync(path)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.warn(`[flake-reporter] WARNING: cannot parse registry at ${path}`);
    return { entries: [] };
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Normalises a path for comparison: forward slashes, no leading "./" or "/". */
export function normalizePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/**
 * Converts a glob-ish pattern into a RegExp.
 * `**` matches across path segments, `*` matches within a segment.
 */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        source += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(ch)) {
      source += "\\" + ch;
    } else {
      source += ch;
    }
  }
  return new RegExp("^" + source + "$");
}

/**
 * Returns the path variants a registry pattern may be written against:
 *   - repo-relative  ("frontend/src/lib/foo.test.ts")
 *   - stack-relative ("src/lib/foo.test.ts" — the form used in the registry)
 */
export function pathVariants(filePath, scope) {
  const repoRelative = normalizePath(filePath);
  const variants = [repoRelative];
  if (scope && repoRelative.startsWith(scope + "/")) {
    variants.push(repoRelative.slice(scope.length + 1));
  }
  return variants;
}

/**
 * Matches a test file against one quarantine entry.
 *
 * Registry patterns are written relative to the stack root (e.g.
 * `src/lib/foo.test.ts`), but Jest reports repo-relative paths (e.g.
 * `frontend/src/lib/foo.test.ts`). Both variants are checked, and a pattern
 * may also be a glob (a path with a double-star segment) or a bare file name.
 */
export function matchesQuarantinePattern(entry, filePath, scope) {
  if (!entry || !entry.pattern) return false;
  if (
    entry.scope &&
    entry.scope !== "other" &&
    scope &&
    entry.scope !== scope
  ) {
    return false;
  }

  const pattern = normalizePath(entry.pattern);
  const variants = pathVariants(filePath, scope);

  if (pattern.includes("*") || pattern.includes("/")) {
    const re = globToRegExp(pattern);
    return variants.some((candidate) => re.test(candidate));
  }

  // Bare file name (or fragment) — match on any path segment or suffix.
  return variants.some(
    (candidate) =>
      candidate === pattern ||
      candidate.endsWith("/" + pattern) ||
      candidate.includes("/" + pattern + "/"),
  );
}

/** Finds the first quarantine entry that covers a test file. */
export function findQuarantineEntry(registry, filePath, scope) {
  const entries = registry?.entries ?? [];
  return (
    entries.find((entry) => matchesQuarantinePattern(entry, filePath, scope)) ??
    null
  );
}

// ─── Parse Jest JSON results ─────────────────────────────────────────────────

/**
 * Jest JSON result shape (jest --json):
 * {
 *   testResults: [{
 *     testFilePath: string,
 *     status: "passed"|"failed",
 *     testResults: [{
 *       fullName: string,
 *       status: "passed"|"failed"|"pending",
 *       duration: number,
 *       failureMessages: string[]
 *     }]
 *   }]
 * }
 */
function parseJestResults(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    return raw;
  } catch (err) {
    console.warn(`[flake-reporter] WARNING: cannot read ${filePath}: ${err.message}`);
    return null;
  }
}

function repoRelativePath(testFilePath) {
  const absolute = String(testFilePath ?? "");
  const relative = absolute.startsWith(ROOT)
    ? absolute.slice(ROOT.length)
    : absolute;
  return normalizePath(relative);
}

/**
 * Extract flake candidates from a Jest JSON result.
 * A "pass-after-retry" pattern is inferred when a suite-level status is
 * "passed" but contains individual test results with failureMessages
 * (Jest retryTimes leaves the suite passing but records the initial failures).
 */
export function extractFlakeCandidates(jestResult, scope) {
  if (!jestResult?.testResults) return [];

  const candidates = [];

  for (const suite of jestResult.testResults) {
    const filePath = suite.testFilePath ?? "";

    for (const test of suite.testResults ?? []) {
      const hasRetryFailure =
        test.status === "passed" &&
        Array.isArray(test.failureMessages) &&
        test.failureMessages.length > 0;

      const wasActuallyFailed =
        test.status === "failed";

      if (hasRetryFailure || wasActuallyFailed) {
        candidates.push({
          fullName: test.fullName,
          filePath: repoRelativePath(filePath),
          status: test.status,
          failureMessages: test.failureMessages ?? [],
          duration: test.duration ?? 0,
          scope: scope ?? "other",
          detectedAt: new Date().toISOString(),
          isPassAfterRetry: hasRetryFailure,
        });
      }
    }
  }

  return candidates;
}

/**
 * Every test FILE seen in the run, with the number of failed tests in it.
 * Used by the weekly report to tell "quarantined and still failing" apart
 * from "quarantined but clean" (ready for re-promotion).
 */
export function extractObservedFiles(jestResult, scope) {
  if (!jestResult?.testResults) return [];

  const byFile = new Map();

  for (const suite of jestResult.testResults) {
    const filePath = repoRelativePath(suite.testFilePath ?? "");
    const tests = suite.testResults ?? [];
    const failures = tests.filter((t) => t.status === "failed").length;

    const existing = byFile.get(filePath);
    if (existing) {
      existing.suites += 1;
      existing.failures += failures;
    } else {
      byFile.set(filePath, {
        filePath,
        scope: scope ?? "other",
        suites: 1,
        failures,
      });
    }
  }

  return [...byFile.values()];
}

// ─── Weekly summary generator ────────────────────────────────────────────────

/**
 * Classifies every quarantine entry against the observed CI results:
 *   - "not-observed"          — the test did not run in the reporting window
 *   - "still-flaky"           — observed and failed at least once
 *   - "ready-for-repromotion" — observed and never failed (mitigation works)
 */
export function classifyQuarantineEntries(registry, observedFiles) {
  const entries = registry?.entries ?? [];

  return entries.map((entry) => {
    const matches = observedFiles.filter((observed) =>
      matchesQuarantinePattern(entry, observed.filePath, observed.scope),
    );
    const failures = matches.reduce((sum, m) => sum + (m.failures ?? 0), 0);

    let status = "not-observed";
    if (matches.length > 0) {
      status = failures > 0 ? "still-flaky" : "ready-for-repromotion";
    }

    return {
      ...entry,
      observedRuns: matches.length,
      observedFailures: failures,
      status,
    };
  });
}

export function generateWeeklySummary(reportDir, registry, outputPath, options = {}) {
  if (!existsSync(reportDir)) {
    console.warn(`[flake-reporter] Report dir ${reportDir} does not exist — nothing to summarise.`);
    return { markdown: null, repromotionReady: [] };
  }

  const files = readdirSync(reportDir).filter(
    (f) => f.endsWith(".json") && f !== "weekly-summary.json",
  );

  const allCandidates = [];
  const observedFiles = [];

  for (const file of files) {
    try {
      const report = JSON.parse(readFileSync(join(reportDir, file), "utf8"));
      if (Array.isArray(report.candidates)) {
        allCandidates.push(...report.candidates);
      }
      if (Array.isArray(report.observedFiles)) {
        observedFiles.push(...report.observedFiles);
      }
    } catch {
      // skip unparseable reports
    }
  }

  // Deduplicate and count by fullName
  const freq = new Map();
  for (const c of allCandidates) {
    const key = `${c.scope}::${c.fullName}`;
    if (!freq.has(key)) {
      freq.set(key, { ...c, count: 0 });
    }
    freq.get(key).count++;
  }

  // Sort by frequency descending
  const ranked = [...freq.values()].sort((a, b) => b.count - a.count);

  // Cross-reference with the quarantine registry — a candidate is quarantined
  // when its file matches a registry pattern for that scope.
  const quarantineStatus = (candidate) =>
    findQuarantineEntry(registry, candidate.filePath, candidate.scope)
      ? "quarantined"
      : "new";

  const quarantinedCount = ranked.filter(
    (c) => quarantineStatus(c) === "quarantined",
  ).length;
  const newCount = ranked.length - quarantinedCount;

  const entries = classifyQuarantineEntries(registry, observedFiles);
  const repromotionReady = entries.filter(
    (e) => e.status === "ready-for-repromotion",
  );
  const stillFlaky = entries.filter((e) => e.status === "still-flaky");

  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Flaky Test Weekly Report — ${today}`,
    "",
    `Generated from **${files.length}** CI run report(s) in \`${reportDir}\`.`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total flake candidates detected | ${ranked.length} |`,
    `| Already quarantined | ${quarantinedCount} |`,
    `| New (not yet quarantined) | ${newCount} |`,
    `| Quarantine entries ready for re-promotion | ${repromotionReady.length} |`,
    `| Quarantine entries still failing | ${stillFlaky.length} |`,
    "",
    "## Ranked by frequency",
    "",
    "| Rank | Test | File | Scope | Occurrences | Quarantined? |",
    "|------|------|------|-------|-------------|-------------|",
  ];

  ranked.forEach((c, i) => {
    const isQ = quarantineStatus(c) === "quarantined";
    const shortName = c.fullName.length > 60
      ? c.fullName.slice(0, 57) + "…"
      : c.fullName;
    lines.push(
      `| ${i + 1} | ${shortName} | \`${c.filePath}\` | ${c.scope} | ${c.count} | ${isQ ? "✓" : "—"} |`,
    );
  });

  lines.push(
    "",
    "## Quarantine registry",
    "",
    `Active entries in \`.github/flaky-tests-quarantine.json\`: **${entries.length}**`,
    "",
    "| Pattern | Scope | Owner | Expires | Observed runs | Failures | Status |",
    "|---------|-------|-------|---------|---------------|----------|--------|",
  );

  if (entries.length === 0) {
    lines.push("| _no entries_ | — | — | — | — | — | — |");
  }

  for (const entry of entries) {
    lines.push(
      `| \`${entry.pattern}\` | ${entry.scope} | @${entry.owner} | ${entry.expires_on} | ${entry.observedRuns} | ${entry.observedFailures} | ${entry.status} |`,
    );
  }

  if (repromotionReady.length > 0) {
    lines.push(
      "",
      `> ✅ **${repromotionReady.length} entr${repromotionReady.length === 1 ? "y is" : "ies are"} ready for re-promotion** — the quarantined test ran clean all week, so the mitigation works and the entry should be removed (or extended with a justification):`,
      "",
    );
    for (const entry of repromotionReady) {
      lines.push(
        `- \`${entry.pattern}\` (scope: ${entry.scope}, owner: @${entry.owner}, expires ${entry.expires_on})`,
      );
    }
  }

  if (stillFlaky.length > 0) {
    lines.push(
      "",
      `> ⚠ **${stillFlaky.length} quarantined entr${stillFlaky.length === 1 ? "y is" : "ies are"} still failing** — the mitigation is not holding, update the registry entry (new mitigation, new expiry, or re-open an issue):`,
      "",
    );
    for (const entry of stillFlaky) {
      lines.push(
        `- \`${entry.pattern}\` (scope: ${entry.scope}, owner: @${entry.owner}, ${entry.observedFailures} failure(s) observed)`,
      );
    }
  }

  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const expired = entries.filter((e) => {
    const d = new Date(e.expires_on + "T00:00:00.000Z");
    return d < todayDate;
  });

  if (expired.length > 0) {
    lines.push(
      "",
      `> ⚠ **${expired.length} expired entr${expired.length === 1 ? "y" : "ies"}** — these must be fixed or extended:`,
      "",
    );
    expired.forEach((e) => {
      lines.push(`- \`${e.pattern}\` (expired ${e.expires_on}, owner: @${e.owner})`);
    });
  }

  lines.push(
    "",
    "## Next steps",
    "",
    "1. For new candidates not yet quarantined: open an issue and add an entry to `.github/flaky-tests-quarantine.json`.",
    "2. For quarantined tests: check if they can be fixed before their expiry.",
    "3. Entries marked *ready for re-promotion* must be removed from the registry (the flake is gone).",
    "4. Expired entries will cause `validate-flaky-quarantine.mjs` to fail CI — fix them promptly.",
    "",
    "---",
    "",
    `_Report generated by \`scripts/flake-reporter.mjs\` at ${new Date().toISOString()}_`,
  );

  const markdown = lines.join("\n");

  // Ensure output dir exists
  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  writeFileSync(outputPath, markdown, "utf8");
  console.log(`[flake-reporter] Weekly summary written to ${outputPath}`);

  // Also write JSON for downstream consumption
  const jsonOut = outputPath.replace(/\.md$/, ".json");
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ranked,
        quarantineCount: entries.length,
        quarantineEntries: entries,
        repromotionReady: repromotionReady.map((e) => e.pattern),
        stillFlaky: stillFlaky.map((e) => e.pattern),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[flake-reporter] Weekly JSON written to ${jsonOut}`);

  if (options.failOnRepromotion && repromotionReady.length > 0) {
    console.error(
      `[flake-reporter] ${repromotionReady.length} quarantine entr${repromotionReady.length === 1 ? "y is" : "ies are"} ready for re-promotion — remove the entr${repromotionReady.length === 1 ? "y" : "ies"} from the registry.`,
    );
  }

  return { markdown, repromotionReady };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  const registry = loadRegistry(args.registry);

  // Weekly aggregation mode
  if (args.weeklyOutput && args.reportDir) {
    const { repromotionReady } = generateWeeklySummary(
      args.reportDir,
      registry,
      args.weeklyOutput,
      { failOnRepromotion: args.failOnRepromotion },
    );
    process.exit(
      args.failOnRepromotion && repromotionReady.length > 0 ? 2 : 0,
    );
  }

  // Per-run reporting mode
  if (args.results.length === 0) {
    console.log("[flake-reporter] No --results files provided. Nothing to analyse.");
    process.exit(0);
  }

  const allCandidates = [];
  const allObservedFiles = [];

  for (let i = 0; i < args.results.length; i++) {
    const resultFile = args.results[i];
    const scope = args.scopes[i] ?? "other";

    if (!existsSync(resultFile)) {
      console.warn(`[flake-reporter] WARNING: results file not found: ${resultFile}`);
      continue;
    }

    const jestResult = parseJestResults(resultFile);
    if (!jestResult) continue;

    const candidates = extractFlakeCandidates(jestResult, scope);
    const observedFiles = extractObservedFiles(jestResult, scope);

    for (const candidate of candidates) {
      candidate.quarantined = Boolean(
        findQuarantineEntry(registry, candidate.filePath, candidate.scope),
      );
    }

    allCandidates.push(...candidates);
    allObservedFiles.push(...observedFiles);
    console.log(
      `[flake-reporter] ${scope}: ${candidates.length} flake candidate(s) from ${resultFile}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID ?? "local",
    sha: process.env.GITHUB_SHA ?? "local",
    ref: process.env.GITHUB_REF ?? "local",
    totalCandidates: allCandidates.length,
    newCandidates: allCandidates.filter((c) => !c.quarantined).length,
    quarantinedCandidates: allCandidates.filter((c) => c.quarantined).length,
    candidates: allCandidates,
    observedFiles: allObservedFiles,
  };

  // Write report
  if (args.output) {
    const outDir = dirname(args.output);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(args.output, JSON.stringify(report, null, 2), "utf8");
    console.log(`[flake-reporter] Report written to ${args.output}`);
  }

  // Print summary to stdout for GitHub Actions step summary
  if (allCandidates.length > 0) {
    console.log(`\n[flake-reporter] ⚠ ${allCandidates.length} flake candidate(s) detected:`);
    allCandidates.forEach((c) => {
      const tag = c.quarantined ? "[quarantined]" : "[NEW]";
      console.log(`  ${tag} ${c.scope} :: ${c.fullName}`);
      console.log(`         ${c.filePath}`);
    });
    console.log(
      "\nNew candidates should be added to .github/flaky-tests-quarantine.json.",
    );
  } else {
    console.log("[flake-reporter] No flake candidates detected.");
  }

  process.exit(0);
}

// Only run the CLI when executed directly — the pure helpers above are
// imported by scripts/__tests__/flake-reporter.test.mjs.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
