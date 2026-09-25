import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "./config";
import { PrismaClient } from "./generated/prisma/client";

// Prisma 7 talks to Postgres through the `pg` driver via an adapter. `pg` keeps a connection
// pool, so one PrismaClient per process is correct — never create one per request.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
});
