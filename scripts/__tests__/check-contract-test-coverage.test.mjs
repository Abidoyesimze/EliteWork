/**
 * Tests for scripts/check-contract-test-coverage.mjs
 *
 * The guard is what keeps the "Contracts Required Gate" honest: every
 * integration test file has to be a cargo test target, otherwise the suite
 * silently stops running in CI.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  analyseTestCoverage,
  collectDeclaredModules,
  resolveModuleFile,
} from "../check-contract-test-coverage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../../scripts/check-contract-test-coverage.mjs");

function makeMetadata({
  tests = [],
  lib = true,
  packageDir = "/repo/contracts/amana_escrow",
} = {}) {
  return {
    packages: [
      {
        name: "amana_escrow",
        manifest_path: `${packageDir}/Cargo.toml`,
        targets: [
          ...(lib
            ? [
                {
                  name: "amana_escrow",
                  kind: ["cdylib", "rlib", "lib"],
                  src_path: `${packageDir}/src/lib.rs`,
                },
              ]
            : []),
          ...tests.map((file) => ({
            name: file.replace(/\.rs$/, ""),
            kind: ["test"],
            src_path: `${packageDir}/tests/${file}`,
          })),
        ],
      },
    ],
  };
}

/** Creates <tmp>/Cargo.toml + <tmp>/tests/<file> and returns the tmp dir. */
function makePackageDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "contract-test-coverage-"));
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "Cargo.toml"), "# fixture\n", "utf8");
  for (const file of files) {
    writeFileSync(join(dir, "tests", file), "// test\n", "utf8");
  }
  return dir;
}

/**
 * Creates a crate with an inline test module tree:
 *   src/lib.rs            — declares `mod tests;`
 *   src/tests/mod.rs      — declares one `pub mod <name>;` per entry
 *   src/tests/<name>.rs   — the inline test module itself
 */
function makeCrateWithInlineTests(moduleNames) {
  const dir = mkdtempSync(join(tmpdir(), "contract-test-coverage-src-"));
  const srcDir = join(dir, "src");
  const inlineDir = join(srcDir, "tests");
  mkdirSync(inlineDir, { recursive: true });
  writeFileSync(join(dir, "Cargo.toml"), "# fixture\n", "utf8");
  writeFileSync(join(srcDir, "lib.rs"), "mod tests;\n", "utf8");
  writeFileSync(
    join(inlineDir, "mod.rs"),
    moduleNames.map((name) => `pub mod ${name};\n`).join(""),
    "utf8",
  );
  for (const name of moduleNames) {
    writeFileSync(join(inlineDir, `${name}.rs`), "// test\n", "utf8");
  }
  return { dir, srcDir, inlineDir };
}

describe("analyseTestCoverage", () => {
  let dir;
  let testsDir;

  beforeEach(() => {
    dir = makePackageDir([]);
    testsDir = join(dir, "tests");
  });

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("reports full coverage when every file is a test target", () => {
    for (const file of ["a_tests.rs", "b_tests.rs"]) {
      writeFileSync(join(testsDir, file), "// test\n", "utf8");
    }
    const coverage = analyseTestCoverage(
      makeMetadata({
        tests: ["a_tests.rs", "b_tests.rs"],
        packageDir: dir,
      }),
      testsDir,
    );
    expect(coverage.missing).toHaveLength(0);
    expect(coverage.stale).toHaveLength(0);
    expect(coverage.hasLibTarget).toBe(true);
    expect(coverage.integrationFiles).toHaveLength(2);
    expect(coverage.integrationTargets).toHaveLength(2);
  });

  it("flags an integration file that is not registered as a test target", () => {
    for (const file of ["a_tests.rs", "orphan_tests.rs"]) {
      writeFileSync(join(testsDir, file), "// test\n", "utf8");
    }
    const coverage = analyseTestCoverage(
      makeMetadata({ tests: ["a_tests.rs"], packageDir: dir }),
      testsDir,
    );
    expect(coverage.missing).toEqual(["orphan_tests.rs"]);
  });

  it("flags a test target whose source file disappeared", () => {
    const coverage = analyseTestCoverage(
      makeMetadata({ tests: ["gone_tests.rs"], packageDir: dir }),
      testsDir,
    );
    expect(coverage.stale).toEqual(["gone_tests.rs"]);
  });

  it("reports a missing library target", () => {
    writeFileSync(join(testsDir, "a_tests.rs"), "// test\n", "utf8");
    const coverage = analyseTestCoverage(
      makeMetadata({ tests: ["a_tests.rs"], lib: false, packageDir: dir }),
      testsDir,
    );
    expect(coverage.hasLibTarget).toBe(false);
  });

  it("throws when the package is missing from the metadata", () => {
    expect(() =>
      analyseTestCoverage({ packages: [] }, "/tmp"),
    ).toThrow(/amana_escrow/);
  });
});

describe("collectDeclaredModules", () => {
  let crate;

  afterEach(() => {
    if (crate?.dir && existsSync(crate.dir)) {
      rmSync(crate.dir, { recursive: true, force: true });
    }
  });

  it("resolves `mod name;` to the flat file or the directory module", () => {
    crate = makeCrateWithInlineTests(["alpha_tests"]);
    expect(resolveModuleFile(crate.srcDir, "tests")).toBe(
      join(crate.srcDir, "tests", "mod.rs"),
    );
    expect(resolveModuleFile(crate.srcDir, "alpha")).toBeNull();
  });

  it("collects every file reachable through a `mod` declaration", () => {
    crate = makeCrateWithInlineTests(["alpha_tests", "beta_tests"]);
    const declared = collectDeclaredModules(join(crate.srcDir, "lib.rs"));

    expect(declared.has(join(crate.srcDir, "tests", "mod.rs"))).toBe(true);
    expect(declared.has(join(crate.srcDir, "tests", "alpha_tests.rs"))).toBe(
      true,
    );
    expect(declared.has(join(crate.srcDir, "tests", "beta_tests.rs"))).toBe(
      true,
    );
  });

  it("ignores inline module blocks", () => {
    crate = makeCrateWithInlineTests([]);
    writeFileSync(
      join(crate.srcDir, "lib.rs"),
      "mod tests;\nmod inline { fn helper() {} }\n",
      "utf8",
    );
    const declared = collectDeclaredModules(join(crate.srcDir, "lib.rs"));
    expect(declared.has(join(crate.srcDir, "tests", "mod.rs"))).toBe(true);
    expect(declared.size).toBe(1);
  });
});

describe("analyseTestCoverage — inline test modules", () => {
  let crate;

  afterEach(() => {
    if (crate?.dir && existsSync(crate.dir)) {
      rmSync(crate.dir, { recursive: true, force: true });
    }
  });

  it("reports every inline test module as declared", () => {
    crate = makeCrateWithInlineTests(["alpha_tests", "beta_tests"]);
    const coverage = analyseTestCoverage(
      makeMetadata({ packageDir: crate.dir }),
      join(crate.dir, "tests"),
      crate.srcDir,
    );

    expect(coverage.inlineTestFiles).toEqual(["alpha_tests.rs", "beta_tests.rs"]);
    expect(coverage.undeclaredInlineModules).toHaveLength(0);
  });

  it("flags an inline test module that is not declared in the module tree", () => {
    crate = makeCrateWithInlineTests(["alpha_tests"]);
    writeFileSync(
      join(crate.inlineDir, "orphan_tests.rs"),
      "// test\n",
      "utf8",
    );

    const coverage = analyseTestCoverage(
      makeMetadata({ packageDir: crate.dir }),
      join(crate.dir, "tests"),
      crate.srcDir,
    );

    expect(coverage.undeclaredInlineModules).toEqual(["orphan_tests.rs"]);
  });
});

describe("check-contract-test-coverage.mjs — CLI", () => {
  it("passes node --check (no syntax errors)", () => {
    expect(() => {
      execFileSync("node", ["--check", SCRIPT], { stdio: "pipe" });
    }).not.toThrow();
  });

  it("fails with exit code 1 when a test file is not covered", () => {
    const dir = makePackageDir(["a_tests.rs", "orphan_tests.rs"]);
    const metadataPath = join(dir, "metadata.json");
    writeFileSync(
      metadataPath,
      JSON.stringify(makeMetadata({ tests: ["a_tests.rs"], packageDir: dir })),
      "utf8",
    );

    let status = 0;
    let stderr = "";
    try {
      execFileSync("node", [SCRIPT, "--metadata", metadataPath], {
        stdio: "pipe",
      });
    } catch (err) {
      status = err.status;
      stderr = err.stderr?.toString() ?? "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(status).toBe(1);
    expect(stderr).toContain("orphan_tests.rs");
  });

  it("fails with exit code 1 when an inline test module is not declared", () => {
    const crate = makeCrateWithInlineTests(["alpha_tests"]);
    writeFileSync(
      join(crate.inlineDir, "orphan_tests.rs"),
      "// test\n",
      "utf8",
    );

    const metadataPath = join(crate.dir, "metadata.json");
    writeFileSync(
      metadataPath,
      JSON.stringify(makeMetadata({ packageDir: crate.dir })),
      "utf8",
    );

    let status = 0;
    let stderr = "";
    try {
      execFileSync("node", [SCRIPT, "--metadata", metadataPath], {
        stdio: "pipe",
      });
    } catch (err) {
      status = err.status;
      stderr = err.stderr?.toString() ?? "";
    } finally {
      rmSync(crate.dir, { recursive: true, force: true });
    }

    expect(status).toBe(1);
    expect(stderr).toContain("orphan_tests.rs");
    expect(stderr).toContain("src/tests/mod.rs");
  });
});
