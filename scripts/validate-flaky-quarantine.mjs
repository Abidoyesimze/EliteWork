#!/usr/bin/env node
/**
 * validate-flaky-quarantine.mjs
 *
 * Validates .github/flaky-tests-quarantine.json against the rules in
 * docs/flaky-tests-policy.md:
 *   1. All entries have required fields (owner, expires_on, scope, pattern, reason, mitigation).
 *   2. No entry has expires_on in the past (expired entries block CI).
 *   3. expires_on is a valid ISO date (YYYY-MM-DD).
 *   4. scope is one of the allowed values.
 *   5. expires_on is at most MAX_EXPIRY_DAYS days in the future — a longer
 *      quarantine needs an explicit `justification` (policy §4).
 *   6. The same scope + pattern is not quarantined twice.
 *
 * Exit codes:
 *   0 — registry is valid
 *   1 — validation errors found (prints details)
 *
 * Usage:
 *   node scripts/validate-flaky-quarantine.mjs
 *   node scripts/validate-flaky-quarantine.mjs --allow-expired  (CI dry-run)
 *   node scripts/validate-flaky-quarantine.mjs --registry path/to/registry.json
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = resolve(
  __dirname,
  "../.github/flaky-tests-quarantine.json",
);
const ALLOWED_SCOPES = ["frontend", "backend", "contracts", "e2e", "other"];
const REQUIRED_FIELDS = ["owner", "expires_on", "scope", "pattern", "reason", "mitigation"];

/** Maximum quarantine window allowed without a written justification. */
export const MAX_EXPIRY_DAYS = 30;

/** GitHub username shape — a non-conforming owner is a warning, not an error. */
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// ─── Parse flags ────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    allowExpired: false,
    registry: DEFAULT_REGISTRY_PATH,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--allow-expired":
        args.allowExpired = true;
        break;
      case "--registry":
        args.registry = resolve(argv[++i]);
        break;
    }
  }

  return args;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validates a parsed registry.
 *
 * @param {object} registry parsed registry JSON
 * @param {object} [options]
 * @param {boolean} [options.allowExpired] downgrade expired entries to warnings
 * @param {Date}   [options.today]       "now", for deterministic tests
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateRegistry(registry, options = {}) {
  const allowExpired = options.allowExpired ?? false;
  const today = options.today ? new Date(options.today) : new Date();
  today.setHours(0, 0, 0, 0);

  const errors = [];
  const warnings = [];

  if (!Array.isArray(registry?.entries)) {
    return {
      errors: ["registry.entries must be an array"],
      warnings,
    };
  }

  const seen = new Map();

  for (let i = 0; i < registry.entries.length; i++) {
    const entry = registry.entries[i];
    const label = `entries[${i}] (pattern: ${entry.pattern ?? "unknown"})`;

    // Required fields
    for (const field of REQUIRED_FIELDS) {
      if (!entry[field]) {
        errors.push(`${label}: missing required field "${field}"`);
      }
    }

    // expires_on format
    if (entry.expires_on) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires_on)) {
        errors.push(`${label}: expires_on "${entry.expires_on}" is not YYYY-MM-DD format`);
      } else {
        const expiry = new Date(entry.expires_on + "T00:00:00.000Z");
        if (isNaN(expiry.getTime())) {
          errors.push(`${label}: expires_on "${entry.expires_on}" is not a valid date`);
        } else if (expiry < today) {
          const message = `${label}: expires_on "${entry.expires_on}" is in the past (expired ${Math.ceil((today - expiry) / 86400000)} days ago)`;
          if (allowExpired) {
            warnings.push(message);
          } else {
            errors.push(message + " — fix or extend before merging");
          }
        } else {
          // Policy §4 — quarantine is time-bound: at most 30 days ahead
          // unless the entry carries a written justification.
          const daysAhead = Math.ceil((expiry - today) / 86400000);
          if (daysAhead > MAX_EXPIRY_DAYS) {
            const message = `${label}: expires_on "${entry.expires_on}" is ${daysAhead} days ahead — quarantine must expire within ${MAX_EXPIRY_DAYS} days unless a "justification" is recorded`;
            if (entry.justification && String(entry.justification).trim()) {
              warnings.push(message + " (justification recorded)");
            } else {
              errors.push(message);
            }
          }
        }
      }
    }

    // scope
    if (entry.scope && !ALLOWED_SCOPES.includes(entry.scope)) {
      errors.push(
        `${label}: scope "${entry.scope}" is not one of [${ALLOWED_SCOPES.join(", ")}]`,
      );
    }

    // owner should be a GitHub username
    if (entry.owner && !GITHUB_USERNAME.test(String(entry.owner))) {
      warnings.push(
        `${label}: owner "${entry.owner}" does not look like a GitHub username`,
      );
    }

    // duplicate quarantine entries
    if (entry.scope && entry.pattern) {
      const key = `${entry.scope}::${entry.pattern}`;
      if (seen.has(key)) {
        errors.push(
          `${label}: duplicate quarantine entry for scope "${entry.scope}" and pattern "${entry.pattern}" (first seen at entries[${seen.get(key)}])`,
        );
      } else {
        seen.set(key, i);
      }
    }
  }

  return { errors, warnings };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  let registry;
  try {
    registry = JSON.parse(readFileSync(args.registry, "utf8"));
  } catch (err) {
    console.error(`[flaky-quarantine] ERROR: Cannot read registry at ${args.registry}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  const { errors, warnings } = validateRegistry(registry, {
    allowExpired: args.allowExpired,
  });

  if (warnings.length > 0) {
    console.warn("[flaky-quarantine] WARNINGS:");
    warnings.forEach((w) => console.warn(`  ⚠  ${w}`));
  }

  if (errors.length > 0) {
    console.error(`[flaky-quarantine] FAILED — ${errors.length} error(s) found:`);
    errors.forEach((e) => console.error(`  ✗  ${e}`));
    console.error("");
    console.error(
      "Fix expired entries (extend expires_on or remove the entry) and re-run.",
    );
    process.exit(1);
  }

  const count = registry.entries.length;
  console.log(
    `[flaky-quarantine] OK — ${count} quarantine entr${count === 1 ? "y" : "ies"} validated, none expired.`,
  );
  process.exit(0);
}

// Only run the CLI when executed directly — the pure helpers above are
// imported by scripts/__tests__/validate-flaky-quarantine.test.mjs.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
