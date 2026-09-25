/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  globalSetup: "<rootDir>/tests/global-setup.ts", // once: migrate the test database
  setupFiles: ["<rootDir>/tests/setup-env.ts"], // per test file: point the app at the test DB
  testTimeout: 20000,
  // TS compiles "./x.ts" imports (used by Prisma's generated client) to "./x.js"; when running
  // from source there is no .js file, so map it back to the .ts file.
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
};
