#!/usr/bin/env node
/**
 * check-contract-test-coverage.mjs
 *
 * Guards that the "Contracts Required Gate" in .github/workflows/ci.yml really
 * runs every contract test:
 *
 *   1. Every file in contracts/amana_escrow/tests/*.rs is registered as a
 *      cargo test target (so no integration suite is silently skipped).
 *   2. The library target exists, which is what runs the inline
 *      `#[cfg(test)]` modules under contracts/amana_escrow/src/.
 *   3. Every inline test module under contracts/amana_escrow/src/tests/ is
 *      declared in the module tree (a file that is not declared as a `mod`
 *      is never compiled and its tests never run).
 *   4. No cargo test target points at a file that no longer exists.
 *
 * The check reads `cargo metadata`, so it sees exactly the targets the
 * `cargo test` invocation of the gate will build.
 *
 * Usage:
 *   node scripts/check-contract-test-coverage.mjs
 *   node scripts/check-contract-test-coverage.mjs --metadata metadata.json
 *
 * Exit codes:
 *   0 — every integration test file is covered
 *   1 — coverage gap found (prints the missing/stale targets)
 *   2 — the check could not run (cargo metadata unavailable, package missing)
 */

import { execFileSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONTRACTS_DIR = join(ROOT, "contracts");
const PACKAGE_NAME = "amana_escrow";

/**
 * Cargo target kinds that make up the library target. The contract crate is
 * declared as `crate-type = ["cdylib", "rlib"]`, so the library target is
 * reported with those kinds instead of the plain "lib" kind.
 */
const LIBRARY_KINDS = ["lib", "rlib", "dylib", "cdylib", "proc-macro"];

function fail(message) {
  console.error(`[contract-test-coverage] FAILED — ${message}`);
  process.exit(1);
}

/**
 * Reads cargo metadata for the contracts workspace.
 * @param {string} [metadataPath] read metadata from a file instead of cargo
 */
export function loadCargoMetadata(metadataPath) {
  if (metadataPath) {
    return JSON.parse(readFileSync(metadataPath, "utf8"));
  }
  const raw = execFileSync(
    "cargo",
    ["metadata", "--locked", "--format-version", "1", "--no-deps"],
    { cwd: CONTRACTS_DIR, encoding: "utf8" },
  );
  return JSON.parse(raw);
}

/**
 * Resolves a `mod <name>;` declaration to the file cargo would compile.
 *
 * @param {string} dir directory the declaration was found in
 * @param {string} name module name
 * @returns {string|null} absolute path of the module file, or null
 */
export function resolveModuleFile(dir, name) {
  const flat = join(dir, `${name}.rs`);
  if (existsSync(flat)) return flat;
  const nested = join(dir, name, "mod.rs");
  if (existsSync(nested)) return nested;
  return null;
}

/**
 * Walks the module tree of a crate root and returns every module file that
 * is reachable through a `mod <name>;` declaration.
 *
 * Inline modules (`mod name { ... }`) are part of their parent file and are
 * therefore always compiled — only declared-but-separate files can be lost.
 *
 * @param {string} rootFile absolute path of the crate root (e.g. src/lib.rs)
 * @returns {Set<string>} absolute paths of all reachable module files
 */
export function collectDeclaredModules(rootFile) {
  const declared = new Set();
  const visited = new Set();
  const stack = [rootFile];

  // `mod name;` — the trailing `;` (instead of a `{`) marks a separate file.
  const declaration = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;

  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || visited.has(file) || !existsSync(file)) continue;
    visited.add(file);

    const source = readFileSync(file, "utf8");
    declaration.lastIndex = 0;
    let match;
    while ((match = declaration.exec(source)) !== null) {
      const child = resolveModuleFile(dirname(file), match[1]);
      if (!child) continue;
      declared.add(child);
      stack.push(child);
    }
  }

  return declared;
}

/**
 * Compares the integration test files on disk with the cargo test targets.
 *
 * @param {object} metadata parsed `cargo metadata` output
 * @param {string} testsDir absolute path to the package's tests/ directory
 * @param {string} [srcDir] absolute path to the package's src/ directory
 * @returns {{integrationFiles: string[], integrationTargets: string[],
 *            missing: string[], stale: string[], hasLibTarget: boolean,
 *            inlineTestFiles: string[], undeclaredInlineModules: string[]}}
 */
export function analyseTestCoverage(metadata, testsDir, srcDir) {
  const pkg = (metadata?.packages ?? []).find((p) => p.name === PACKAGE_NAME);
  if (!pkg) {
    throw new Error(`package "${PACKAGE_NAME}" not found in cargo metadata`);
  }

  const targets = pkg.targets ?? [];

  const integrationTargets = targets
    .filter((t) => (t.kind ?? []).includes("test"))
    .map((t) => ({
      name: t.name,
      srcPath: t.src_path,
      file: basename(t.src_path),
    }));

  const hasLibTarget = targets.some((t) =>
    (t.kind ?? []).some((kind) => LIBRARY_KINDS.includes(kind)),
  );

  const integrationFiles = existsSync(testsDir)
    ? readdirSync(testsDir)
        .filter((f) => f.endsWith(".rs"))
        .sort()
    : [];

  const targetedFiles = new Set(integrationTargets.map((t) => t.file));

  const missing = integrationFiles.filter((f) => !targetedFiles.has(f));
  const stale = integrationTargets
    .filter((t) => !existsSync(t.srcPath))
    .map((t) => t.file);

  // Inline `#[cfg(test)]` modules live in src/tests/. A file that is not
  // declared as a `mod` in the module tree is never compiled, so its tests
  // would silently never run.
  const inlineTestFiles = [];
  const undeclaredInlineModules = [];
  const inlineTestDir = srcDir ? join(srcDir, "tests") : null;

  if (inlineTestDir && existsSync(inlineTestDir)) {
    const libTarget = targets.find((t) =>
      (t.kind ?? []).some((kind) => LIBRARY_KINDS.includes(kind)),
    );
    const declared = libTarget
      ? collectDeclaredModules(libTarget.src_path)
      : new Set();

    for (const file of readdirSync(inlineTestDir)
      .filter((f) => f.endsWith(".rs") && f !== "mod.rs")
      .sort()) {
      const absolute = join(inlineTestDir, file);
      inlineTestFiles.push(file);
      if (!declared.has(absolute)) {
        undeclaredInlineModules.push(file);
      }
    }
  }

  return {
    integrationFiles,
    integrationTargets,
    missing,
    stale,
    hasLibTarget,
    inlineTestFiles,
    undeclaredInlineModules,
  };
}

function main() {
  const argv = process.argv.slice(2);
  let metadataPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--metadata") metadataPath = argv[++i];
  }

  let metadata;
  try {
    metadata = loadCargoMetadata(metadataPath);
  } catch (err) {
    console.error(
      `[contract-test-coverage] ERROR: could not read cargo metadata: ${err.message}`,
    );
    process.exit(2);
  }

  const pkg = (metadata?.packages ?? []).find((p) => p.name === PACKAGE_NAME);
  const packageDir = pkg
    ? dirname(pkg.manifest_path)
    : join(ROOT, "contracts", PACKAGE_NAME);
  const testsDir = join(packageDir, "tests");
  const srcDir = join(packageDir, "src");

  let coverage;
  try {
    coverage = analyseTestCoverage(metadata, testsDir, srcDir);
  } catch (err) {
    console.error(`[contract-test-coverage] ERROR: ${err.message}`);
    process.exit(2);
  }

  const {
    integrationFiles,
    integrationTargets,
    missing,
    stale,
    hasLibTarget,
    inlineTestFiles,
    undeclaredInlineModules,
  } = coverage;

  console.log(
    `[contract-test-coverage] cargo test targets: ${integrationTargets.length} integration suite(s) + ${hasLibTarget ? "1" : "0"} library target (inline #[cfg(test)] modules)`,
  );
  console.log(
    `[contract-test-coverage] integration files on disk: ${integrationFiles.length}`,
  );
  console.log(
    `[contract-test-coverage] inline test modules declared: ${inlineTestFiles.length - undeclaredInlineModules.length}/${inlineTestFiles.length}`,
  );

  if (missing.length > 0) {
    fail(
      `integration test file(s) are not registered as cargo test targets and would never run:\n  - ${missing.join("\n  - ")}`,
    );
  }

  if (stale.length > 0) {
    fail(
      `cargo test target(s) point at a file that no longer exists:\n  - ${stale.join("\n  - ")}`,
    );
  }

  if (!hasLibTarget) {
    fail(
      "no library target found — the inline #[cfg(test)] modules would not run",
    );
  }

  if (undeclaredInlineModules.length > 0) {
    fail(
      `inline test module(s) are not declared in the module tree and would never run:\n  - ${undeclaredInlineModules.join("\n  - ")}\n  Add \`pub mod <name>;\` to contracts/amana_escrow/src/tests/mod.rs.`,
    );
  }

  console.log(
    `[contract-test-coverage] OK — all ${integrationFiles.length} integration test file(s) and ${inlineTestFiles.length} inline test module(s) are covered by the Contracts Required Gate.`,
  );
  for (const target of integrationTargets.sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    console.log(`  - ${target.name}`);
  }
  process.exit(0);
}

// Only run the CLI when executed directly — the pure helpers above are
// imported by scripts/__tests__/check-contract-test-coverage.test.mjs.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
