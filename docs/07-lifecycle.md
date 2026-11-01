# Phase 7 — Lifecycle

## BEFORE

### 1. Why storage only ever grows

Nothing in the system deletes anything on its own. Old versions pile up (Phase 6), "deleted" files are
gone instantly with no undo, and failures between "write to MinIO" and "write to Postgres" leave **orphan**
bytes that nobody will ever see or delete.

### 2. Two kinds of lifecycle

| | S3/MinIO lifecycle rules (ILM) | Application lifecycle job |
|---|---|---|
| Runs | inside MinIO, on a schedule | in our code |
| Knows about | keys, prefixes, tags, ages | users, trash, quotas, versions **and** our database |
| Good for | things the database doesn't track | anything the database tracks |
| Danger | deletes bytes behind the database's back → rows point at nothing | slower; we must run it |

**Rule of thumb:** if Postgres has a row for it, the app expires it — otherwise the row would dangle.

### 3. What we'll build

| Task | Where | Why |
|---|---|---|
| **Trash** (soft delete, 30 days, restore) | app | users delete by mistake; Google Drive and Dropbox do the same |
| Purge expired trash | app job | rows + every version go together |
| Prune versions over `MAX_VERSIONS` | app job | after the limit is lowered |
| **Reconcile**: delete orphan bytes, report dangling rows | app job | catches every failure between the two stores |
| Expired delete markers | MinIO ILM rule | Postgres never tracks markers |
| Abandoned multipart uploads | MinIO built-in | `stale_uploads_expiry=24h` |

---

## AFTER

### Files

```
infra/minio/init.sh         ILM rule (expire orphan delete markers); separate *-test bucket
backend/prisma/migrations/…_trash   files.deleted_at + index
backend/src/file-service.ts purgeFile(), trimHistory() — shared by routes and the job
backend/src/lifecycle.ts    purgeExpiredTrash, pruneVersions, reconcile, runLifecycle
backend/src/server.ts       runs the job every LIFECYCLE_INTERVAL_MINUTES (default 60)
backend/scripts/lifecycle.ts  `npm run lifecycle [-- --dry-run]` for cron or by hand
frontend/src/Trash.tsx      trash view: restore, delete forever, empty trash
```

### API changes

| Method | Path | Result |
|---|---|---|
| DELETE | `/files/:id` | **now moves to trash** (204) |
| GET | `/files/trash` | trashed files with `deletedAt` and `purgeAt` |
| POST | `/files/trash/:id/restore` | back to the file list |
| DELETE | `/files/trash/:id` | permanent: rows, every version, no delete marker |
| DELETE | `/files/trash` | empty the trash |

Trashed files are invisible to every other route (download, versions, …) and **still count toward the
quota**, because the bytes still exist.

### Reconcile, in detail

```
Postgres: every (objectKey, versionId) we know      MinIO: ListObjectVersions under users/
        known ─────────────┐                ┌──────────── seen
                           ▼                ▼
   in MinIO, not in Postgres, older than 60 min  → orphan  → DELETE that version
   in Postgres, not in MinIO                     → dangling → log an error, change nothing
```

- The **60-minute grace period** protects uploads in flight: their bytes exist a moment before their row.
- **Dangling rows are never auto-deleted**: missing bytes means data loss, and deleting the evidence
  would hide it. A human decides (Phase 11 restores from backup).

### A safety bug caught before it shipped

Tests used the **same bucket** as development. Reconcile running in a test sees your real dev files as
"not in the test database" and would delete them. Fix: tests use `<bucket>-test`, guarded in
`tests/test-env.ts` the same way the test database must end in `_test`.

### MinIO findings

- `mc ilm rule import` with `AbortIncompleteMultipartUpload` → **rejected** ("XML not well-formed"). MinIO
  doesn't support that rule; instead it removes stale multipart uploads itself
  (`mc admin config get local api` → `stale_uploads_expiry=24h`). On AWS you **must** add that rule, or
  abandoned parts are billed forever.
- `ExpiredObjectDeleteMarker` is accepted. `import` replaces the whole config, so init stays idempotent.

### What the tests prove (76 passing, +9)

- Delete → hidden from list and downloads, visible in trash with `purgeAt = deletedAt + 30 days`, restorable.
- Trash still counts toward quota. Empty trash removes all versions in MinIO and doesn't touch Bob's trash.
- Bob gets 404 restoring or purging Alice's trash; a file not in the trash can't be purged.
- Purge job removes 31-day-old trash (rows + bytes) and keeps 1-day-old trash.
- `pruneVersions(1)` on a 3-version file leaves one version in both stores.
- Reconcile: a fresh orphan is kept (grace period); dry run reports without deleting; real run deletes; a
  second run finds nothing. A row whose bytes were deleted is reported as dangling and kept.

### Known limitations

- Every API instance runs the job. With several, use a Postgres advisory lock or run it from cron only.
- Reconcile lists the whole bucket each run. At hundreds of millions of objects, use S3 Inventory reports.

### Interview questions

1. Why implement trash in the app instead of relying on S3 versioning's delete markers?
2. When should expiry be an S3 lifecycle rule, and when an application job?
3. What is an orphan object? How do they appear, and how do you find them safely?
4. Why the grace period in reconcile? What would go wrong without it?
5. Why is a dangling row reported rather than deleted?
6. What happens to abandoned multipart uploads on AWS S3 if you don't configure anything?
7. Why must tests never share a bucket with development when a cleanup job exists?
