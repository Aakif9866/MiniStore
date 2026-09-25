// Prisma CLI config (migrate, generate). Run Prisma commands from the backend/ directory.
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// One .env for the whole repo, at the root. Real env vars (CI, containers) take precedence.
config({ path: "../.env", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
