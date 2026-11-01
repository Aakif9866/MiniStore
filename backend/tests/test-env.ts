import path from "node:path";
import { config } from "dotenv";

/** Loads the repo .env and returns the test database URL, refusing anything that isn't a test DB. */
export function loadTestEnv(): string {
  config({ path: path.resolve(__dirname, "../../.env"), quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  // Tests TRUNCATE tables. Make it impossible to point them at real data by mistake.
  if (!url || !new URL(url).pathname.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL must be set and name a database ending in _test");
  }
  // Same idea for MinIO: the lifecycle tests delete objects the test DB doesn't know about.
  // Idempotent: every test file calls this in the same process (--runInBand).
  if (!process.env.MINIO_BUCKET?.endsWith("-test")) process.env.MINIO_BUCKET += "-test";
  return url;
}
