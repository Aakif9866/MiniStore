import { execSync } from "node:child_process";
import { loadTestEnv } from "./test-env";

// Apply the same migrations production would get, to the test database.
export default function globalSetup() {
  const url = loadTestEnv();
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
}
