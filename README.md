# MiniStore

A small, production-style file storage service — a private "Google Drive" backed by S3-style object
storage. Users sign up, upload files, keep version history, restore from a trash, and download through
short-lived signed links.

It's built phase by phase as a learning lab for **object storage (MinIO / S3 API)**, backend
infrastructure, observability, load testing, and (still to come) failure testing and disaster recovery.
Everything runs **locally in Docker** — no cloud account or deployment needed.

> **Core rule:** file **bytes** live in **MinIO**. Facts **about** files (owner, name, size, versions,
> where the bytes are) live in **PostgreSQL**. Neither store does the other's job.

## Where things stand

| Phase | Topic | Status | Doc |
|---|---|---|---|
| 0 | Overview & architecture | ✅ done | [00](docs/00-overview.md) |
| 1 | Object storage + MinIO in Docker | ✅ done | [01](docs/01-object-storage.md) |
| 2 | Backend: Express + Postgres + MinIO | ✅ done | [02](docs/02-backend.md) |
| — | Web frontend (React + Vite + Tailwind) | ✅ done | [frontend/README](frontend/README.md) |
| 3 | Secure uploads: type sniffing, exe blocking, quotas, rate limits, headers | ✅ done | [03](docs/03-secure-uploads.md) |
| 4 | Presigned download URLs | ✅ done | [04](docs/04-presigned-urls.md) |
| 5 | Large files: streaming + S3 multipart | ✅ done | [05](docs/05-large-files.md) |
| 6 | Versioning: history, restore, pruning | ✅ done | [06](docs/06-versioning.md) |
| 7 | Lifecycle: trash, retention, orphan cleanup, MinIO ILM | ✅ done | [07](docs/07-lifecycle.md) |
| 8 | Observability: logs, RED metrics, Grafana, alerts, readiness | ✅ done | [08](docs/08-observability.md) |
| 9 | Load testing (k6) + multi-core cluster mode | 🟡 **in progress** | [09](docs/09-load-testing.md) |
| 10 | Failure testing | ⬜ not started | |
| 11 | Backup & disaster recovery | ⬜ | |
| 12 | High availability (distributed MinIO, erasure coding) | ⬜ | |
| 13 | CI/CD (GitHub Actions) + Docker images | ⬜ | |
| 14 | Security review (httpOnly cookies, encryption at rest, checklist) | ⬜ | |
| 15 | Production design (10 → 10,000+ users) | ⬜ | |

**Tests:** 83 passing (unit + integration against real Postgres and MinIO).
**Branch:** all work since Phase 2 is on `frontend-and-docs` (not yet merged into `main`).

## Tech stack

| Layer | Tech | Why |
|---|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4 | Fast dev server, typed API calls, utility-first styling |
| API | Node.js, Express 5, TypeScript, Zod | Small, explicit HTTP layer; Zod validates every input and the config |
| Auth | JWT (HS256) + scrypt password hashing | Stateless sessions; scrypt is built into Node and memory-hard |
| Metadata DB | PostgreSQL 18 + Prisma 7 | Relations, constraints, migrations |
| Object storage | MinIO via **AWS SDK v3** (S3 API) | Same code would work against AWS S3 — only the endpoint changes |
| Uploads | busboy + `@aws-sdk/lib-storage` | Streams into S3 multipart; memory doesn't grow with file size |
| Observability | pino, prom-client, Prometheus, Grafana | JSON logs with request ids; RED metrics; dashboard + alerts |
| Load testing | k6 (in Docker) | Scripted scenarios with pass/fail thresholds |
| Infra | Docker Compose | One command brings up everything |
| Tests | Jest + Supertest | Integration tests hit real services, in a separate DB and bucket |

## Architecture

```
 Browser (React, :5173)
    │ /api/*  (Vite dev proxy)                     ▲ presigned GET (bytes straight from MinIO)
    ▼                                              │
 Express API (:3000)  ── WEB_CONCURRENCY workers ──┤
    │  JWT · Zod · rate limit · security headers   │
    │                                              │
    │ metadata (SQL)            bytes (S3 API, least-privilege key, versioned bucket)
    ▼                           ▼
 PostgreSQL (:5433)          MinIO (:9100 API, :9101 Console)
   users, files,               ministore-dev        (app data)
   file_versions               ministore-dev-test   (tests only)

 Metrics (:9464, localhost only) ◀── Prometheus (:9090) ◀── Grafana (:3001)
 Lifecycle job (hourly): purge old trash · prune versions · delete orphan objects
```

Every port is bound to `127.0.0.1`. Nothing is reachable from your network.

## How the main flows work

**Sign up / log in** — Zod validates; scrypt hashes; the `UNIQUE` constraint rejects duplicate emails
(409); login returns a 1-hour JWT. `/auth/*` is rate-limited per IP (429).

**Upload** (`POST /files/upload`, multipart) — JWT check → work out how much quota is left → busboy
streams the body → the first 16 bytes are sniffed (executables → 415; the real type is stored, not the
client's claim) → bytes stream to MinIO as an S3 multipart upload (8 MiB parts) under a key **we**
generate (`users/<userId>/<uuid>`) → size and quota limits enforced mid-stream (413/403, no partial
object left) → Postgres rows for the file and its first version. If the database write fails, the
uploaded version is deleted.

**Download** — `GET /files/:id/download-url` checks ownership and returns a 5-minute presigned URL,
pinned to the current version and forced to `attachment`. The browser downloads straight from MinIO.

**New version / restore** — uploading to `/files/:id/versions` adds an S3 version; restore copies an
old version on top (history is never rewritten). History is capped at `MAX_VERSIONS`. Quota counts
every version.

**Delete** — moves the file to the trash (restorable for 30 days). Permanent delete removes the rows,
then every S3 version and delete marker.

**Lifecycle job** — hourly (or `npm run lifecycle`): purges expired trash, prunes versions, deletes
orphan bytes older than 1 hour, and *reports* (never deletes) rows whose bytes are missing.

Someone else's file always returns **404, not 403**, so ids can't be probed.

## Project structure

```
.
├── docker-compose.yml      MinIO, Postgres, init job, mc CLI; profiles: observability, loadtest
├── .env.example            Every setting, documented. Copy to .env (git-ignored)
├── infra/
│   ├── minio/init.sh       Buckets, versioning, lifecycle rule, least-privilege policy + app user
│   ├── postgres/init/      Creates the ministore_test database
│   ├── prometheus/         Scrape config + alert rules
│   └── grafana/            Datasource + "MiniStore — API & Storage" dashboard
├── backend/                Express API                       → backend/README.md
├── frontend/               React UI                          → frontend/README.md
├── loadtest/ministore.js   k6 scenarios: read, steady, login, upload, mixed
└── docs/                   One write-up per phase: why, what was built, what broke, interview questions
```

## Run it locally

Prerequisites: Docker Desktop, Node.js 20.19+ (22+ recommended), **and ~5 GB free disk**.

```bash
cp .env.example .env                     # replace every "change-me" (openssl rand -hex 20)
docker compose up -d                     # MinIO + Postgres (+ creates buckets and the app user)

cd backend && npm install
npm run db:migrate                       # create/upgrade tables — needed on any fresh database
npm run dev                              # API on :3000, metrics on :9464, pretty logs
npm test                                 # 83 tests (separate _test database and -test bucket)

cd ../frontend && npm install && npm run dev   # UI on http://localhost:5173

# Optional
docker compose --profile observability up -d                           # Prometheus + Grafana
docker compose run --rm k6 run -e SCENARIO=read /scripts/ministore.js   # load test (see docs/09)
npm run lifecycle -- --dry-run                                          # what cleanup would do

docker compose --profile observability stop    # stop; data survives in Docker volumes
```

| Service | URL |
|---|---|
| Web app | http://localhost:5173 |
| API | http://127.0.0.1:3000 (`/health` liveness, `/ready` readiness) |
| API metrics | http://127.0.0.1:9464/metrics |
| Grafana | http://127.0.0.1:3001 (admin / `GRAFANA_ADMIN_PASSWORD`) |
| Prometheus | http://127.0.0.1:9090 (`/alerts` for firing alerts) |
| MinIO Console | http://127.0.0.1:9101 (root user/password from `.env`) |
| PostgreSQL | `127.0.0.1:5433` |

## Session log — where we stopped (2026-11-01)

What happened this session, in order:

1. Checked the project (Phases 0–2 done, 23 tests) → added the **React frontend** and READMEs.
2. **Security & compliance check** before pushing: no secrets in git; patched `body-parser`
   (GHSA-27r3-jxmh-p828, high-severity DoS); licences all permissive except MinIO (AGPL, used
   unmodified as a separate service → no obligations); `minio.license` git-ignored (not needed to run).
   Pushed to `origin/frontend-and-docs`.
3. Decided **no deployment**: local Docker only.
4. Built **Phases 3–8**, each with tests, a doc and a commit. Tests went 23 → 83.
5. Started **Phase 9**: found and fixed the single-core bottleneck (cluster mode, ~2.5× throughput),
   measured login, then **the laptop's disk filled up** during the upload test and the session ended.

**Not yet done:**

- Phase 9: the upload and mixed load scenarios must be re-run with free disk. Checklist at the end of
  [docs/09](docs/09-load-testing.md).
- Commits after the first push (Phases 3–9) are **local only** — run `git push` when ready.
- Phases 10–15 not started.
- No LICENSE file yet (without one, others may not reuse the code; MIT is common for portfolios).

**Before running anything again:** free disk space. Docker's disk image grows and doesn't shrink on its
own (`docker system df` shows what's using it).

## Suggested order to understand the code

1. [docs/00-overview.md](docs/00-overview.md) — the big picture and the "two stores" problem.
2. `infra/minio/init.sh` + [docs/01](docs/01-object-storage.md) — buckets, policies, least privilege.
3. `backend/src/app.ts` → `routes/auth.routes.ts` → `auth.ts` — how a request is handled and authenticated.
4. `backend/src/routes/files.routes.ts` — read top to bottom; every route follows "find owned file → act".
5. `backend/src/upload-stream.ts` + `upload-policy.ts` — the hardest part: streaming, sniffing, limits.
6. `backend/src/storage.ts` — every S3 call in one file (multipart via lib-storage, presign, versions, purge).
7. `backend/src/file-service.ts` + `lifecycle.ts` — keeping Postgres and MinIO consistent over time.
8. `backend/src/observability.ts` + `server.ts` — logs, metrics, cluster mode.
9. `backend/tests/integration/*.test.ts` — each test is a small, runnable explanation of one behaviour.
10. `frontend/src/api.ts` → `Files.tsx` → `Versions.tsx` / `Trash.tsx`.

Each phase doc ends with interview questions — try answering them without looking.
