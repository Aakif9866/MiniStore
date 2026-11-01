import { loadTestEnv } from "./test-env";

// Runs before the app's modules load, so src/config.ts sees these values.
process.env.DATABASE_URL = loadTestEnv();
process.env.MAX_UPLOAD_BYTES = String(1024 * 1024); // 1 MiB keeps the "too large" test fast
process.env.MAX_USER_STORAGE_BYTES = String(3 * 1024 * 1024); // small quota so the quota test is cheap
process.env.AUTH_RATE_LIMIT = "10000"; // tests register many users from one IP
process.env.MAX_VERSIONS = "3"; // small, so the pruning test is cheap
process.env.LOG_LEVEL = "silent"; // keep test output readable
