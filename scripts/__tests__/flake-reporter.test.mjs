/**
 * Tests for the flake detection logic used by scripts/flake-reporter.mjs
 *
 * The pure helpers are imported from the script itself, so the tests cover
 * the code that actually runs in CI.
 */

import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  classifyQuarantineEntries,
  extractFlakeCandidates,
  extractObservedFiles,
  findQuarantineEntry,
  generateWeeklySummary,
  globToRegExp,
  matchesQuarantinePattern,
  normalizePath,
} from "../flake-reporter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../../scripts/flake-reporter.mjs");

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeSuite(filePath, tests) {
  return { testFilePath: filePath, status: "passed", testResults: tests };
}

function makeTest(fullName, status, failureMessages = []) {
  return { fullName, status, failureMessages, duration: 50 };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("extractFlakeCandidates", () => {
  describe("clean run — no candidates", () => {
    it("returns empty for a fully passing run", () => {
      const result = {
        testResults: [
          makeSuite("/app/src/foo.test.ts", [
            makeTest("foo passes", "passed", []),
            makeTest("bar passes", "passed", []),
          ]),
        ],
      };
      expect(extractFlakeCandidates(result, "frontend")).toHaveLength(0);
    });

    it("returns empty for pending/skipped tests", () => {
      const result = {
        testResults: [
          makeSuite("/app/src/foo.test.ts", [
            makeTest("skipped", "pending", []),
          ]),
        ],
      };
      expect(extractFlakeCandidates(result, "backend")).toHaveLength(0);
    });
  });

  describe("pass-after-retry detection", () => {
    it("flags a passed test that has failureMessages as a flake candidate", () => {
      const result = {
        testResults: [
          makeSuite("/app/src/foo.test.ts", [
            makeTest("flaky test", "passed", ["Expected true, received false"]),
          ]),
        ],
      };
      const candidates = extractFlakeCandidates(result, "frontend");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].isPassAfterRetry).toBe(true);
      expect(candidates[0].fullName).toBe("flaky test");
      expect(candidates[0].scope).toBe("frontend");
    });

    it("does not flag a passed test with empty failureMessages", () => {
      const result = {
        testResults: [
          makeSuite("/app/src/foo.test.ts", [makeTest("clean pass", "passed", [])]),
        ],
      };
      expect(extractFlakeCandidates(result, "frontend")).toHaveLength(0);
    });
  });

  describe("actual failure detection", () => {
    it("flags a failed test as a candidate (not pass-after-retry)", () => {
      const result = {
        testResults: [
          makeSuite("/app/src/bar.test.ts", [
            makeTest("always fails", "failed", ["Error: not equal"]),
          ]),
        ],
      };
      const candidates = extractFlakeCandidates(result, "backend");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].isPassAfterRetry).toBe(false);
      expect(candidates[0].status).toBe("failed");
    });
  });

  describe("mixed suite", () => {
    it("only picks up flaky and failed tests, leaves clean ones alone", () => {
      const result = {
        testResults: [
          makeSuite("/app/src/mixed.test.ts", [
            makeTest("clean", "passed", []),
            makeTest("flaky", "passed", ["transient failure"]),
            makeTest("broken", "failed", ["hard fail"]),
            makeTest("skipped", "pending", []),
          ]),
        ],
      };
      const candidates = extractFlakeCandidates(result, "frontend");
      expect(candidates).toHaveLength(2);
      expect(candidates.map((c) => c.fullName)).toEqual(
        expect.arrayContaining(["flaky", "broken"]),
      );
    });
  });

  describe("edge cases", () => {
    it("returns empty for null/undefined input", () => {
      expect(extractFlakeCandidates(null, "frontend")).toHaveLength(0);
      expect(extractFlakeCandidates(undefined, "frontend")).toHaveLength(0);
    });

    it("returns empty for a result with no testResults array", () => {
      expect(extractFlakeCandidates({}, "frontend")).toHaveLength(0);
    });

    it("handles suite with no test results array", () => {
      const result = {
        testResults: [{ testFilePath: "/app/src/empty.test.ts" }],
      };
      expect(extractFlakeCandidates(result, "backend")).toHaveLength(0);
    });

    it("defaults scope to 'other' when not provided", () => {
      const result = {
        testResults: [
          makeSuite("/app/src/foo.test.ts", [makeTest("flaky", "passed", ["fail"])]),
        ],
      };
      const candidates = extractFlakeCandidates(result, undefined);
      expect(candidates[0].scope).toBe("other");
    });
  });
});

describe("extractObservedFiles", () => {
  it("records every observed file, including clean ones", () => {
    const result = {
      testResults: [
        makeSuite("/app/src/clean.test.ts", [makeTest("ok", "passed", [])]),
        makeSuite("/app/src/broken.test.ts", [
          makeTest("bad", "failed", ["boom"]),
        ]),
      ],
    };
    const observed = extractObservedFiles(result, "frontend");
    expect(observed).toHaveLength(2);
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ failures: 0 }),
        expect.objectContaining({ failures: 1 }),
      ]),
    );
  });

  it("returns an empty list for malformed input", () => {
    expect(extractObservedFiles(null, "frontend")).toEqual([]);
    expect(extractObservedFiles({}, "frontend")).toEqual([]);
  });
});

describe("matchesQuarantinePattern", () => {
  const entry = {
    owner: "dev",
    expires_on: "2099-01-01",
    scope: "frontend",
    pattern: "src/components/ui/__tests__/MyComponent.test.tsx",
    reason: "race",
    mitigation: "retryTimes(1)",
  };

  it("matches a stack-relative registry pattern against a repo-relative path", () => {
    expect(
      matchesQuarantinePattern(
        entry,
        "frontend/src/components/ui/__tests__/MyComponent.test.tsx",
        "frontend",
      ),
    ).toBe(true);
  });

  it("matches a repo-relative registry pattern", () => {
    expect(
      matchesQuarantinePattern(
        { ...entry, pattern: "frontend/src/components/ui/__tests__/MyComponent.test.tsx" },
        "frontend/src/components/ui/__tests__/MyComponent.test.tsx",
        "frontend",
      ),
    ).toBe(true);
  });

  it("matches a glob pattern", () => {
    expect(
      matchesQuarantinePattern(
        { ...entry, pattern: "src/**/__tests__/*.test.tsx" },
        "frontend/src/components/ui/__tests__/MyComponent.test.tsx",
        "frontend",
      ),
    ).toBe(true);
  });

  it("matches a bare file name", () => {
    expect(
      matchesQuarantinePattern(
        { ...entry, pattern: "MyComponent.test.tsx" },
        "frontend/src/components/ui/__tests__/MyComponent.test.tsx",
        "frontend",
      ),
    ).toBe(true);
  });

  it("does not match a different file", () => {
    expect(
      matchesQuarantinePattern(
        entry,
        "frontend/src/components/ui/__tests__/OtherComponent.test.tsx",
        "frontend",
      ),
    ).toBe(false);
  });

  it("does not match a path from another scope", () => {
    expect(
      matchesQuarantinePattern(
        entry,
        "backend/src/components/ui/__tests__/MyComponent.test.tsx",
        "backend",
      ),
    ).toBe(false);
  });

  it("matches any scope when the entry scope is 'other'", () => {
    expect(
      matchesQuarantinePattern(
        { ...entry, scope: "other" },
        "backend/src/components/ui/__tests__/MyComponent.test.tsx",
        "backend",
      ),
    ).toBe(true);
  });
});

describe("findQuarantineEntry", () => {
  it("returns the entry that covers the file", () => {
    const registry = {
      entries: [
        {
          scope: "frontend",
          pattern: "src/lib/foo.test.ts",
          owner: "dev",
          expires_on: "2099-01-01",
          reason: "r",
          mitigation: "m",
        },
      ],
    };
    const found = findQuarantineEntry(
      registry,
      "frontend/src/lib/foo.test.ts",
      "frontend",
    );
    expect(found).not.toBeNull();
    expect(found.owner).toBe("dev");
  });

  it("returns null when nothing covers the file", () => {
    const registry = {
      entries: [
        {
          scope: "frontend",
          pattern: "src/lib/foo.test.ts",
          owner: "dev",
          expires_on: "2099-01-01",
          reason: "r",
          mitigation: "m",
        },
      ],
    };
    expect(
      findQuarantineEntry(registry, "frontend/src/lib/bar.test.ts", "frontend"),
    ).toBeNull();
  });
});

describe("classifyQuarantineEntries", () => {
  const registry = {
    entries: [
      {
        scope: "frontend",
        pattern: "src/lib/fixed.test.ts",
        owner: "dev",
        expires_on: "2099-01-01",
        reason: "r",
        mitigation: "m",
      },
      {
        scope: "frontend",
        pattern: "src/lib/still-broken.test.ts",
        owner: "dev",
        expires_on: "2099-01-01",
        reason: "r",
        mitigation: "m",
      },
      {
        scope: "backend",
        pattern: "src/lib/not-run.test.ts",
        owner: "dev",
        expires_on: "2099-01-01",
        reason: "r",
        mitigation: "m",
      },
    ],
  };

  const observed = [
    { filePath: "frontend/src/lib/fixed.test.ts", scope: "frontend", failures: 0 },
    {
      filePath: "frontend/src/lib/still-broken.test.ts",
      scope: "frontend",
      failures: 2,
    },
  ];

  it("marks a clean observed entry as ready for re-promotion", () => {
    const classified = classifyQuarantineEntries(registry, observed);
    const fixed = classified.find((e) => e.pattern === "src/lib/fixed.test.ts");
    expect(fixed.status).toBe("ready-for-repromotion");
  });

  it("marks an entry with failures as still flaky", () => {
    const classified = classifyQuarantineEntries(registry, observed);
    const broken = classified.find(
      (e) => e.pattern === "src/lib/still-broken.test.ts",
    );
    expect(broken.status).toBe("still-flaky");
    expect(broken.observedFailures).toBe(2);
  });

  it("marks an entry that never ran as not observed", () => {
    const classified = classifyQuarantineEntries(registry, observed);
    const notRun = classified.find((e) => e.pattern === "src/lib/not-run.test.ts");
    expect(notRun.status).toBe("not-observed");
  });
});

describe("generateWeeklySummary", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flake-reporter-"));
    mkdirSync(join(dir, "ci-runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts quarantined candidates correctly and reports re-promotion candidates", () => {
    writeFileSync(
      join(dir, "ci-runs", "frontend-1.json"),
      JSON.stringify({
        candidates: [
          {
            fullName: "quarantined test",
            filePath: "frontend/src/lib/fixed.test.ts",
            scope: "frontend",
          },
          {
            fullName: "brand new flake",
            filePath: "frontend/src/lib/new.test.ts",
            scope: "frontend",
          },
        ],
        observedFiles: [
          {
            filePath: "frontend/src/lib/fixed.test.ts",
            scope: "frontend",
            failures: 0,
          },
          {
            filePath: "frontend/src/lib/new.test.ts",
            scope: "frontend",
            failures: 1,
          },
        ],
      }),
    );

    const registry = {
      entries: [
        {
          scope: "frontend",
          pattern: "src/lib/fixed.test.ts",
          owner: "dev",
          expires_on: "2099-01-01",
          reason: "r",
          mitigation: "m",
        },
      ],
    };

    const output = join(dir, "weekly-summary.md");
    const { repromotionReady } = generateWeeklySummary(
      join(dir, "ci-runs"),
      registry,
      output,
    );

    const markdown = readFileSync(output, "utf8");
    expect(markdown).toContain("| Already quarantined | 1 |");
    expect(markdown).toContain("| New (not yet quarantined) | 1 |");
    expect(markdown).toContain("ready for re-promotion");
    expect(repromotionReady).toHaveLength(1);
    expect(repromotionReady[0].pattern).toBe("src/lib/fixed.test.ts");
  });

  it("writes a JSON summary next to the markdown report", () => {
    const output = join(dir, "weekly-summary.md");
    generateWeeklySummary(join(dir, "ci-runs"), { entries: [] }, output);
    const json = JSON.parse(readFileSync(join(dir, "weekly-summary.json"), "utf8"));
    expect(json).toHaveProperty("repromotionReady");
    expect(json).toHaveProperty("quarantineEntries");
  });
});

describe("path helpers", () => {
  it("normalises windows separators and leading slashes", () => {
    expect(normalizePath("frontend\\src\\foo.test.ts")).toBe(
      "frontend/src/foo.test.ts",
    );
    expect(normalizePath("/frontend/src/foo.test.ts")).toBe(
      "frontend/src/foo.test.ts",
    );
  });

  it("compiles globs with ** and *", () => {
    expect(globToRegExp("src/**/foo.test.ts").test("src/a/b/foo.test.ts")).toBe(
      true,
    );
    expect(globToRegExp("src/**/foo.test.ts").test("src/foo.test.ts")).toBe(
      true,
    );
    expect(globToRegExp("src/*.test.ts").test("src/a/foo.test.ts")).toBe(false);
  });
});

// ─── Script syntax check ──────────────────────────────────────────────────

describe("flake-reporter.mjs — script syntax", () => {
  it("passes node --check (no syntax errors)", () => {
    expect(() => {
      execSync(`node --check ${SCRIPT}`, { stdio: "pipe" });
    }).not.toThrow();
  });
});
