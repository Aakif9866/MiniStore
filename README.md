# MiniStore

A production-style file & object storage service (a small internal "S3 / Google Drive"), built phase by
phase to learn MinIO, backend infrastructure, observability, failure handling, and disaster recovery.

**Core rule:** file bytes live in **MinIO**; metadata (owner, name, size, version) lives in **PostgreSQL**.

Stack: Node.js + Express + TypeScript · PostgreSQL + Prisma · MinIO · JWT · Docker Compose ·
Jest/Supertest · k6 · Prometheus + Grafana · GitHub Actions

## Status

| Phase | Topic | Status |
|---|---|---|
| 0 | [Overview & architecture](docs/00-overview.md) | ✅ done |
| 1 | Object storage + MinIO in Docker | next |
| 2–15 | See the [roadmap](docs/00-overview.md#7-roadmap--what-you-should-be-able-to-explain-after-each-phase) | — |

## How the docs work

Each phase has one file in [`docs/`](docs/) with two sections:
- **Before** — what we're building and why (read before coding)
- **After** — what was built, what we learned, what's still open
