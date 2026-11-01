# MiniStore — Backend

Express 5 + TypeScript API. It authenticates users, stores file bytes in MinIO, and stores file
metadata in PostgreSQL. See the [root README](../README.md) for the big picture.

## Structure

```
backend/
├── src/
│   ├── server.ts            Entry point: cluster mode (WEB_CONCURRENCY), metrics server, lifecycle timer, graceful shutdown
│   ├── app.ts               Builds the Express app: /health, /ready, routers. No listen() → testable
│   ├── config.ts            Loads ../.env and validates every variable with Zod; exits if invalid
│   ├── auth.ts              scrypt password hashing, JWT signing, requireAuth middleware
│   ├── security.ts          Security headers, in-memory rate limiter
│   ├── upload-policy.ts     Filename sanitising, content-type sniffing, executable blocking
│   ├── upload-stream.ts     Streams a multipart upload into an S3 multipart upload, enforcing limits
│   ├── storage.ts           S3 client (AWS SDK v3) → MinIO: get/delete/presign/copy versions/purge + timing middleware
│   ├── file-service.ts      purgeFile, trimHistory — shared by routes and the lifecycle job
│   ├── lifecycle.ts         Trash purge, version pruning, orphan reconcile
│   ├── observability.ts     pino logger, Prometheus metrics, request ids, metrics app
│   ├── db.ts                The single PrismaClient (connection pool) per process
│   ├── errors.ts            HttpError + the one error handler that formats every error
│   └── routes/
│       ├── auth.routes.ts   POST /auth/register, POST /auth/login (rate-limited)
│       └── files.routes.ts  files, versions, trash, usage, downloads (all require a JWT)
├── prisma/
│   ├── schema.prisma        Tables: users, files, file_versions
│   └── migrations/          init → file_versions (with hand-written backfill) → trash
├── scripts/
│   ├── lifecycle.ts         `npm run lifecycle [-- --dry-run]`
│   └── measure-upload-memory.ts   Phase 5 memory experiment
└── tests/
    ├── unit/                Passwords, upload policy, rate limiter
    ├── integration/         auth, files, presign, upload-stream, versions, lifecycle, observability
    ├── global-setup.ts      Migrates the test database before the run
    └── test-env.ts          Refuses to run unless the DB ends in "_test"; uses the "-test" bucket
```

## Life of a request

```
request
  → requestObserver      request id, one JSON log line, duration histogram (route pattern label)
  → securityHeaders      nosniff, no framing, no caching, strict CSP
  → express.json()       10 KB cap — files never come as JSON
  → router
      → rateLimit        /auth only: 20 per IP per 15 min → 429
      → requireAuth      verify "Authorization: Bearer <jwt>", set req.userId     (files routes)
      → handler          Zod-validate → Postgres (Prisma) and/or MinIO (S3 SDK)
                         uploads: receiveUpload() streams + sniffs + enforces size/quota
  → errorHandler         HttpError → its status · ZodError → 400 · anything else → logged, 500
```

Express 5 forwards errors thrown in `async` handlers to `errorHandler` automatically, so handlers
just `throw new HttpError(404, "File not found")`.

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Liveness: the process is up |
| GET | `/ready` | — | Readiness: Postgres and MinIO reachable → 200, else 503 naming the failing one |
| POST | `/auth/register` | — | `{ email, password }` → 201 · 409 email taken · 429 rate-limited |
| POST | `/auth/login` | — | → `{ token }` · 401 bad credentials (same message for unknown email) |
| POST | `/files/upload` | JWT | multipart `file` → 201 · 403 quota · 413 too large · 415 executable |
| GET | `/files` | JWT | Your 100 newest files (not trashed) |
| GET | `/files/usage` | JWT | `{ usedBytes, quotaBytes, fileCount }` — used counts every version and the trash |
| GET | `/files/:id` | JWT | One file's metadata |
| GET | `/files/:id/download-url` | JWT | `{ url, expiresAt }` — presigned, 5 min, pinned to the current version |
| GET | `/files/:id/download` | JWT | Streams the bytes through the API (fallback) |
| DELETE | `/files/:id` | JWT | Move to trash → 204 |
| GET | `/files/:id/versions` | JWT | Version history, newest first, with `isCurrent` |
| POST | `/files/:id/versions` | JWT | Upload new content → 201 (same checks as a new file) |
| POST | `/files/:id/versions/:versionId/restore` | JWT | Copy an old version on top → 200 · 409 if already current |
| GET | `/files/:id/versions/:versionId/download-url` | JWT | Presigned URL for that version |
| DELETE | `/files/:id/versions/:versionId` | JWT | Delete an old version → 204 · 409 for the current one |
| GET | `/files/trash` | JWT | Trashed files with `deletedAt` and `purgeAt` |
| POST | `/files/trash/:id/restore` | JWT | Back to the file list |
| DELETE | `/files/trash/:id` | JWT | Permanently delete: rows, every version, no delete marker |
| DELETE | `/files/trash` | JWT | Empty the trash |

Requests for a file you don't own return `404` — the same as a file that doesn't exist.
Metrics are served separately on `127.0.0.1:9464/metrics`.

## Data model

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `email` (unique), `password_hash` | Hash format: `scrypt$N$r$p$salt$hash`, so parameters can be raised later |
| `files` | `id`, `user_id`, `original_name`, `object_key` (unique), `size`, `version_id`, `deleted_at` | Current state; `deleted_at` set = in the trash |
| `file_versions` | `file_id`, `version_id` (unique per file), `size`, `etag`, `mime_type` | Every stored version; the quota sums this table |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (tsx watch), logs pretty-printed |
| `npm test` | Unit + integration tests (needs `docker compose up -d`) |
| `npm run db:migrate` | Create/apply migrations to the dev database |
| `npm run db:deploy` | Apply existing migrations only (no prompts — for CI/production) |
| `npm run lifecycle` | One lifecycle pass; `-- --dry-run` only reports |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run typecheck` | Type-check without emitting |

## Configuration

All settings come from the repo-root `.env` (see [`.env.example`](../.env.example), every variable is
commented). The app refuses to start if any are missing or invalid — e.g. `JWT_SECRET` shorter than
32 characters.

The backend uses **`MINIO_APP_ACCESS_KEY`**, not the MinIO root account. That key can only read,
write, and delete objects in one bucket (policy created by [`infra/minio/init.sh`](../infra/minio/init.sh)).
