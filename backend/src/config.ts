import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// One .env at the repo root. Variables already set in the environment (CI, Docker) win.
loadDotenv({ path: path.resolve(__dirname, "../../.env"), quiet: true });

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.url(),

  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default("us-east-1"),
  MINIO_BUCKET: z.string().min(3),
  MINIO_APP_ACCESS_KEY: z.string().min(3),
  MINIO_APP_SECRET_KEY: z.string().min(8),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("1h"),

  // Uploads are buffered in memory for now, so this also caps RAM per request (see Phase 5).
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
});

// Fail fast at startup with a clear message, instead of failing on the first request.
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
