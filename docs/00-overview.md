# Phase 0 — Project Overview & Architecture

Every phase doc has two halves:
- **Before**: what we're about to build and why. Read this first.
- **After**: what actually got built, what surprised us, and what's still open. Filled in when the phase is done.

---

## BEFORE

### 1. What we're building

MiniStore is a small internal "Google Drive / S3": users log in, upload files, download them, share
temporary links, and restore old versions.

The core idea of the whole project is one sentence:

> **The file's bytes live in MinIO. Facts about the file live in PostgreSQL.**

Almost every hard problem later on (consistency, failures, backups, scaling) comes from keeping
those two stores in agreement.

### 2. Architecture (development)

```
                ┌──────────────┐
                │    Client    │  (curl / Postman / k6 / later a UI)
                └──────┬───────┘
                       │ HTTP + JWT
                       ▼
                ┌──────────────┐
                │  Backend API │  Node.js + Express + TypeScript
                └──┬────────┬──┘
     SQL (metadata)│        │ S3 API (bytes)
                   ▼        ▼
          ┌────────────┐  ┌────────────┐
          │ PostgreSQL │  │   MinIO    │
          └────────────┘  └────────────┘

Presigned download (Phase 4) — backend is skipped for the bytes:
  Client ──"give me a link"──▶ Backend ──signs URL (no network call)──▶ Client
  Client ─────────────────────── GET signed URL ──────────────────────▶ MinIO

Monitoring (Phase 8):
  Backend /metrics ─┐
  MinIO metrics  ───┼──▶ Prometheus (scrapes + stores time series) ──▶ Grafana (dashboards)
  Postgres export ──┤
  cAdvisor (Docker)─┘
```

Everything runs locally in Docker Compose. No cloud, no Kubernetes.

### 3. Why each component exists

| Component | Problem it solves | Alternative | Needed from |
|---|---|---|---|
| **Express + TypeScript** | HTTP API, auth, validation, the only thing clients talk to | Fastify, NestJS | Phase 2 |
| **PostgreSQL** | Queryable facts: who owns what, names, sizes, versions. Transactions + constraints | MySQL | Phase 2 |
| **MinIO** | Cheap, scalable storage for large blobs via the S3 API | AWS S3, local disk, Postgres `bytea` | Phase 1 |
| **Prisma** (ORM) | Typed DB access + migrations | Sequelize, Knex, raw `pg` | Phase 2 |
| **JWT** | Stateless auth: any backend instance can verify a token without a shared session store | Server sessions (need Redis once you have >1 instance) | Phase 2 |
| **Jest + Supertest** | Prove behaviour, catch regressions | Vitest | Phase 2 |
| **k6** | Load generation with scripted scenarios, JS like the rest of the stack | Locust (Python), JMeter | Phase 9 |
| **Prometheus + Grafana** | Numbers over time: rate, latency, errors, saturation | Datadog, CloudWatch (cloud/paid) | Phase 8 |
| **GitHub Actions** | Every push is linted, tested, built automatically | GitLab CI, Jenkins | Phase 13 |
| **Redis** | **Not needed now.** Candidate later for rate limiting shared across multiple backend instances | in-memory limiter (fine for 1 instance) | Only if a real problem shows up |

### 4. The central design tension: two stores, no shared transaction

An upload touches two systems:

```
1. stream bytes → MinIO      (can fail)
2. INSERT row  → PostgreSQL  (can fail)
```

There is no transaction spanning both. So:

- MinIO succeeds, Postgres fails → **orphan object** (bytes nobody points to; wastes storage).
- Delete the row, MinIO delete fails → same orphan.
- Delete the object first, row delete fails → **dangling row** (user sees a file that 404s). Worse.

The rule we'll follow: **order operations so the failure mode is "orphan object" (harmless, cleanable),
never "dangling row" (user-visible bug).** A periodic cleanup job can remove orphans later.
We will deliberately trigger both failures in Phase 10.

### 5. Choices made up front (and why)

| Decision | Choice | Why | Trade-off |
|---|---|---|---|
| ORM | Prisma | Schema file is readable, generated TS types, simple migrations | Less control over raw SQL; heavier dependency than Knex |
| Load tool | k6 | Same language (JS), good latency percentiles out of the box | Not a real browser; scripts are not Node (no npm packages) |
| Object key format | `users/<userId>/<uuid>` | Never uses the user's filename → no path traversal, no collisions | Keys aren't human-readable (original name lives in Postgres) |
| Upload path (Phase 2) | Through the backend, streamed | Simplest to reason about; backend can validate | Backend bandwidth becomes a bottleneck — we'll measure this in Phase 9 |
| Download path (Phase 4) | Presigned URLs | Bytes don't pass through the backend | Anyone holding the URL can use it until it expires |
| Redis | Skip | No problem that needs it yet | Revisit if we run multiple backend instances |

### 6. Planned repository layout

```
MiniStore/
├── README.md
├── docs/                 ← one doc per phase (Before/After), ADRs, reports
├── docker-compose.yml    ← Phase 1
├── .env.example          ← Phase 1/3 (real .env is git-ignored)
├── backend/              ← Phase 2  (src/, prisma/, tests/)
├── infra/                ← Phase 8  (prometheus/, grafana/)
├── loadtest/             ← Phase 9  (k6 scripts)
└── .github/workflows/    ← Phase 13
```

Folders appear only when the phase that needs them starts.

### 7. Roadmap — what you should be able to explain after each phase

| # | Phase | You can explain… |
|---|---|---|
| 1 | Object storage + MinIO | buckets/objects/keys, why not files in Postgres, access keys, bucket policies |
| 2 | Backend integration | full request path client → auth → MinIO → Postgres → response |
| 3 | Secure uploads | size/MIME limits, filename sanitisation, ownership checks, secrets via env |
| 4 | Presigned URLs | how a signature grants time-limited access without a backend round trip |
| 5 | Large files | streaming vs buffering, multipart upload, retries, measured memory usage |
| 6 | Versioning | S3 version IDs vs Git, listing and restoring versions |
| 7 | Lifecycle | automatic expiry, retention, controlling storage growth |
| 8 | Observability | logs vs metrics vs traces, p50/p95/p99, RED metrics |
| 9 | Load testing | finding the *actual* bottleneck with evidence |
| 10 | Failure testing | what breaks, what the user sees, whether data is safe |
| 11 | Backup & DR | RPO, RTO, restoring from "storage is gone" |
| 12 | High availability | erasure coding, distributed MinIO, availability vs durability |
| 13 | CI/CD | each pipeline stage and why it exists |
| 14 | Security | a checklist with honest status, not "it works so it's secure" |
| 15 | Production design | what changes at 10 → 10,000+ users |

### 8. Phase 0 interview questions

1. Why store file bytes in MinIO and metadata in PostgreSQL instead of everything in one place?
2. An upload writes to MinIO and then to Postgres. What happens if the second step fails? How would you clean up?
3. Why does deletion order (row first vs object first) matter?
4. Why generate the object key yourself instead of using the user's filename?
5. What does the backend gain and lose by streaming uploads through itself vs using presigned upload URLs?
6. Why is JWT a reasonable fit for a service that may later run as multiple instances?
7. When would adding Redis be justified in this system? When would it be over-engineering?
8. Why run everything in Docker Compose before thinking about Kubernetes?

---

## AFTER

- Repository created and connected to `github.com/Aakif9866/MiniStore` over the **personal** SSH key
  (`github-personal` host alias, repo-local git identity — the global work identity is not used here).
- `.gitignore` already blocks `.env` files, so secrets can't be committed by accident from day one.
- No application code yet — intentionally.
- **Open question going into Phase 1:** none. Next step: run MinIO in Docker and learn the Console + `mc`.
