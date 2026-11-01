# MiniStore

A small, production-style file storage service — think a private "Google Drive" backed by S3-style
object storage. Users sign up, upload files, list them, download them, and delete them.

It's built phase by phase as a learning lab for **object storage (MinIO / S3 API)**, backend
infrastructure, and later observability, failure testing, and disaster recovery.

> **Core rule:** file **bytes** live in **MinIO**. Facts **about** files (owner, name, size, where the
> bytes are) live in **PostgreSQL**. Neither store does the other's job.

## Tech stack

| Layer | Tech | Why |
|---|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4 | Fast dev server, typed API calls, utility-first styling |
| API | Node.js, Express 5, TypeScript, Zod | Small, explicit HTTP layer; Zod validates every input |
| Auth | JWT (HS256) + scrypt password hashing | Stateless sessions; scrypt is built into Node and memory-hard |
| Metadata DB | PostgreSQL 18 + Prisma 7 | Relations, unique constraints, migrations |
| Object storage | MinIO via **AWS SDK v3** (S3 API) | Same code would work against AWS S3 — only the endpoint changes |
| Infra | Docker Compose | One command brings up MinIO + Postgres |
| Tests | Jest + Supertest | Integration tests hit a real Postgres and a real MinIO |

## Architecture

```
 Browser (React, :5173)
    │  /api/*  (Vite dev proxy strips "/api")
    ▼
 Express API (:3000) ── JWT check ── Zod validation
    │                         │
    │ metadata (SQL)          │ bytes (S3 API, least-privilege key)
    ▼                         ▼
 PostgreSQL (:5433)       MinIO (:9100 API, :9101 Console)
   users, files             bucket "ministore-dev"
                            key  users/<userId>/<uuid>
```

Everything except the browser runs on `127.0.0.1` only — nothing is exposed to your network.

## How a request flows

### Sign up → log in
1. The frontend sends `POST /api/auth/register` with email + password.
2. The API validates input with Zod, hashes the password with scrypt, and inserts a `users` row.
   Duplicate emails are rejected by the database's `UNIQUE` constraint (→ `409`).
3. The frontend calls `POST /api/auth/login`; the API returns a JWT valid for 1 hour.
4. The frontend stores the token and sends it as `Authorization: Bearer <token>` on every request.

### Upload a file
1. The browser sends the file as `multipart/form-data` (with a progress bar via XHR).
2. `requireAuth` verifies the JWT and attaches `userId` to the request.
3. The API generates the object key itself — `users/<userId>/<random-uuid>`. The user's filename
   is stored only as metadata, so it can never cause path traversal or overwrite another file.
4. **Bytes → MinIO** (`PutObject`), using an app account that can only touch this one bucket.
5. **Metadata → Postgres** (`files` row: name, size, MIME type, ETag, object key).
6. If step 5 fails, the API deletes the object from step 4 so no orphan is left behind.

### Download / delete
- **Download:** look up the row *only if it belongs to the caller* (someone else's file → `404`,
  not `403`, so IDs can't be probed), then stream the object from MinIO straight to the client.
- **Delete:** delete the row first, then the object. A failed object delete leaves a harmless
  invisible orphan; the opposite order could leave a row pointing at nothing.

## Project structure

```
.
├── docker-compose.yml     MinIO + Postgres + one-shot MinIO setup job + mc CLI
├── .env.example           Every setting, documented. Copy to .env (git-ignored)
├── infra/
│   ├── minio/init.sh      Creates the bucket, a least-privilege policy, and the app user
│   └── postgres/init/     Creates the separate ministore_test database on first start
├── backend/               Express API          → see backend/README.md
├── frontend/              React UI             → see frontend/README.md
└── docs/                  One write-up per phase (what, why, what was learned)
```

## Run it locally

Prerequisites: Docker Desktop and Node.js 20.19+.

```bash
# 1. Configure secrets (replace every "change-me" — e.g. with: openssl rand -hex 20)
cp .env.example .env

# 2. Start MinIO + Postgres
docker compose up -d

# 3. Backend (terminal 1)
cd backend
npm install
npm run db:migrate       # create tables in the dev database — needed once per fresh DB
npm run dev              # API on http://127.0.0.1:3000

# 4. Frontend (terminal 2)
cd frontend
npm install
npm run dev              # UI on http://localhost:5173

# Tests (uses the separate ministore_test database)
cd backend && npm test

# Stop everything
docker compose down      # data survives in Docker volumes; add -v to wipe it
```

| Service | URL |
|---|---|
| Web app | http://localhost:5173 |
| API | http://127.0.0.1:3000 (`/health` for a liveness check) |
| MinIO Console | http://127.0.0.1:9101 (root user/password from `.env`) |
| MinIO S3 API | http://127.0.0.1:9100 |
| PostgreSQL | `127.0.0.1:5433` |
| `mc` CLI | `docker compose run --rm mc ls local/ministore-dev` |

## Roadmap

| Phase | Topic | Status |
|---|---|---|
| 0 | [Overview & architecture](docs/00-overview.md) | ✅ done |
| 1 | [Object storage + MinIO in Docker](docs/01-object-storage.md) | ✅ done |
| 2 | [Backend integration (Express + Postgres + MinIO)](docs/02-backend.md) | ✅ done |
| — | Web frontend (React + Vite + Tailwind) | ✅ done |
| 3 | [Secure uploads](docs/03-secure-uploads.md) (type sniffing, exe blocking, quotas, rate limits) | ✅ done |
| 4 | [Presigned URLs](docs/04-presigned-urls.md) (browser ↔ MinIO directly) | ✅ done |
| 5 | [Large files](docs/05-large-files.md) (streaming, multipart upload) | ✅ done |
| 6 | [Versioning](docs/06-versioning.md) (history, restore, pruning) | ✅ done |
| 7 | [Lifecycle](docs/07-lifecycle.md) (trash, retention, orphan cleanup, ILM) | ✅ done |
| 8 | [Observability](docs/08-observability.md) (logs, RED metrics, Grafana, alerts) | ✅ done |
| 9 | Load testing (k6) | next |
| 10 | Failure testing | |
| 11 | Backup & disaster recovery | |
| 12 | High availability (distributed MinIO) | |
| 13 | CI/CD (GitHub Actions) | |
| 14 | Security review | |
| 15 | Production design | |

Each phase doc in [`docs/`](docs/) has a **Before** section (what we're building and why) and an
**After** section (what was built, what broke, what's still open).
