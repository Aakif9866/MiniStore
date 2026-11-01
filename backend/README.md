# MiniStore — Backend

Express 5 + TypeScript API. It authenticates users, stores file bytes in MinIO, and stores file
metadata in PostgreSQL. See the [root README](../README.md) for the big picture.

## Structure

```
backend/
├── src/
│   ├── server.ts            Entry point: starts listening, handles graceful shutdown (SIGTERM/SIGINT)
│   ├── app.ts               Builds the Express app (routes + middleware). No listen() → testable
│   ├── config.ts            Loads ../.env and validates every variable with Zod; exits if invalid
│   ├── auth.ts              scrypt password hashing, JWT signing, requireAuth middleware
│   ├── db.ts                The single PrismaClient (connection pool) for the process
│   ├── storage.ts           S3 client (AWS SDK v3) pointed at MinIO: put / get / delete object
│   ├── errors.ts            HttpError class + the one error handler that formats every error
│   └── routes/
│       ├── auth.routes.ts   POST /auth/register, POST /auth/login
│       └── files.routes.ts  upload, list, get, download, delete (all require a JWT)
├── prisma/
│   ├── schema.prisma        Tables: users, files
│   └── migrations/          SQL migrations, applied in order
├── tests/
│   ├── unit/                Password hashing
│   ├── integration/         Real HTTP requests against real Postgres + MinIO
│   ├── global-setup.ts      Migrates the test database before the run
│   └── test-env.ts          Refuses to run unless the DB name ends in "_test"
└── prisma.config.ts         Prisma 7 config (database URL comes from .env)
```

## Life of a request

```
request
  → express.json() (10 KB cap — files never come as JSON)
  → router
      → requireAuth        verify "Authorization: Bearer <jwt>", set req.userId     (files routes only)
      → multer             parse multipart upload, enforce MAX_UPLOAD_BYTES         (upload only)
      → handler            Zod-validate input → Postgres (Prisma) and/or MinIO (S3 SDK)
  → errorHandler           HttpError → its status · ZodError → 400 · too large → 413 · anything else → 500
```

Express 5 forwards errors thrown in `async` handlers to `errorHandler` automatically, so handlers
just `throw new HttpError(404, "File not found")` — no try/catch boilerplate.

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Liveness check → `{ "status": "ok" }` |
| POST | `/auth/register` | — | `{ email, password }` → `201 { id, email }` · `409` if the email exists |
| POST | `/auth/login` | — | `{ email, password }` → `{ token }` · `401` on bad credentials |
| POST | `/files/upload` | JWT | multipart field `file` → `201` file metadata · `413` if too large |
| GET | `/files` | JWT | Your 100 newest files |
| GET | `/files/:id` | JWT | One file's metadata |
| GET | `/files/:id/download` | JWT | Streams the bytes (`Content-Disposition: attachment`) |
| DELETE | `/files/:id` | JWT | `204` |

Requests for a file you don't own return `404` — the same as a file that doesn't exist.

## Data model

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `email` (unique), `password_hash` | Hash format: `scrypt$N$r$p$salt$hash`, so parameters can be raised later |
| `files` | `id`, `user_id`, `original_name`, `object_key` (unique), `size`, `etag`, `version_id` | `object_key` is where the bytes are in MinIO; `original_name` is display-only |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (tsx watch) |
| `npm test` | Unit + integration tests (needs `docker compose up -d`) |
| `npm run db:migrate` | Create/apply migrations to the dev database |
| `npm run db:deploy` | Apply existing migrations only (no prompts — for CI/production) |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run typecheck` | Type-check without emitting |

## Configuration

All settings come from the repo-root `.env` (see [`.env.example`](../.env.example), every variable is
commented). The app refuses to start if any are missing or invalid — e.g. `JWT_SECRET` shorter than
32 characters.

The backend uses **`MINIO_APP_ACCESS_KEY`**, not the MinIO root account. That key can only read,
write, and delete objects in one bucket (policy created by [`infra/minio/init.sh`](../infra/minio/init.sh)).
