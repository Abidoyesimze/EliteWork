/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/prisma"],
  testMatch: ["**/__tests__/**/*.test.ts", "**/?(*.)+(spec|test).ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // @pact-foundation/pact@16 requires ESM-only https-proxy-agent@9 at
    // module load; Jest's CJS runtime cannot parse it. The agent is never
    // constructed unless a proxy env var is set.
    "^https-proxy-agent$":
      "<rootDir>/src/__tests__/stubs/httpsProxyAgent.ts",
  },
  modulePaths: ["<rootDir>"],
  setupFiles: ["<rootDir>/src/__tests__/setup.ts"],
  collectCoverage: true,
  coverageDirectory: "<rootDir>/coverage",
  coverageReporters: ["text", "lcov", "clover"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/index.ts",
    "!src/**/*.types.ts",
    "!src/__tests__/**",
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 65,
      lines: 70,
      statements: 70,
    },
  },
  forceExit: true,
  detectOpenHandles: true,
};
