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
  // Host the BROWSER uses to reach MinIO. Presigned URLs embed (and sign) this host, so it must be
  // reachable by clients — it differs from S3_ENDPOINT when the backend runs inside Docker.
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  PRESIGN_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
  MINIO_BUCKET: z.string().min(3),
  MINIO_APP_ACCESS_KEY: z.string().min(3),
  MINIO_APP_SECRET_KEY: z.string().min(8),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("1h"),

  // Largest single file. Uploads stream (Phase 5), so this no longer limits server memory.
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1024 ** 3),
  // Total bytes one user may store.
  MAX_USER_STORAGE_BYTES: z.coerce.number().int().positive().default(1024 ** 3),
  // Versions kept per file (Phase 6); the oldest are deleted beyond this.
  MAX_VERSIONS: z.coerce.number().int().min(1).max(100).default(10),
  // Lifecycle (Phase 7)
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  LIFECYCLE_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(60), // 0 = don't run in the API process
  ORPHAN_GRACE_MINUTES: z.coerce.number().int().min(0).default(60),
  // Requests per IP to /auth/* in a 15-minute window. Slows password guessing.
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
});

// Fail fast at startup with a clear message, instead of failing on the first request.
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
