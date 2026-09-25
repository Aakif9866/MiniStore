import { loadTestEnv } from "./test-env";

// Runs before the app's modules load, so src/config.ts sees these values.
process.env.DATABASE_URL = loadTestEnv();
process.env.MAX_UPLOAD_BYTES = String(1024 * 1024); // 1 MiB keeps the "too large" test fast
