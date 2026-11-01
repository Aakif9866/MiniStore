# Phase 6 — Versioning

## BEFORE

### 1. What S3 versioning does

With versioning **enabled** on a bucket:

| Operation | Without versioning | With versioning |
|---|---|---|
| PUT to an existing key | old bytes are gone | old bytes become a **noncurrent version**; new PUT gets a new `VersionId` |
| DELETE key | object is gone | a **delete marker** becomes "current"; every version is still there (and still billed) |
| DELETE key + `VersionId` | — | that one version is permanently removed |
| GET key + `VersionId` | — | read any old version |

Versioning can be **suspended** but never turned off again.

### 2. S3 versions vs Git

| | Git | S3 versioning |
|---|---|---|
| Unit | whole repository snapshot (commit) | one object |
| Stores | diffs/packed objects | **full copy of every version** |
| History | a graph, with branches and merges | a straight line per key |
| Restore | checkout / revert | copy an old version on top (becomes the newest) |

The cost model is the big lesson: ten versions of a 1 GB file use 10 GB.

### 3. Design decisions

- **Postgres is the source of truth for versions** (`file_versions` table), not `ListObjectVersions`.
  One indexed query answers "what does this user store?", so the **quota counts every version**.
- **Restore appends**: it copies the old version on top, creating a new version. History is never rewritten.
- **Cap history** at `MAX_VERSIONS` (default 10) per file; the oldest go first.
- **Deleting a file purges every version and delete marker**. A plain DELETE would leave all the bytes
  behind a marker: invisible to the user, but still on disk — a privacy and cost bug.
- **Downloads are pinned to a version id**, so a concurrent upload can't change what you get mid-way.

---

## AFTER

### Files

```
infra/minio/init.sh                 mc version enable; app policy + GetObjectVersion, DeleteObjectVersion, ListBucketVersions
backend/prisma/migrations/…_file_versions/   new table + backfill of one version per existing file
backend/src/storage.ts              copyVersion(), purgeObject(), versionId on get/presign/delete
backend/src/routes/files.routes.ts  version routes, makeCurrent() with pruning, quota over all versions
frontend/src/Versions.tsx           version history in a native <dialog>
```

### API added

| Method | Path | Result |
|---|---|---|
| GET | `/files/:id/versions` | newest first, with `isCurrent` |
| POST | `/files/:id/versions` | upload new content (same checks as a new file) → 201 |
| POST | `/files/:id/versions/:versionId/restore` | copy that version on top → 200; 409 if already current |
| GET | `/files/:id/versions/:versionId/download-url` | presigned URL for that exact version |
| DELETE | `/files/:id/versions/:versionId` | remove an old version → 204; 409 for the current one |

### The migration needed hand-written SQL

Prisma generated the table, but not the **backfill**: without it, existing files would have no version rows
and would vanish from the quota. Objects written before versioning was enabled have the version id `"null"`
(a literal string in S3), so the backfill uses `COALESCE(version_id, 'null')`.

### What the tests prove (67 passing, +10)

- Two uploads → two versions; the newest is current; the old one still downloads via its own presigned URL.
- Restore creates a **new** version with the old bytes; restoring the current one → 409.
- Pruning: 5 uploads with `MAX_VERSIONS=3` → 3 rows **and** 3 versions in MinIO.
- Deleting the current version → 409; deleting an old one removes it from both stores.
- **Deleting a file leaves 0 versions and 0 delete markers in MinIO.**
- Quota counts all versions (1000 + 1000 bytes = 2000 used).
- An executable uploaded as a new version → 415 and the file is unchanged.
- Bob gets 404 on all five version routes for Alice's file.

### Known limitations

- Two concurrent new-version uploads to the same file: both are stored, and the database's "current" is
  whichever finished last. S3's latest might differ by milliseconds. A per-file lock would fix it.
- Pruning happens on write. Lowering `MAX_VERSIONS` doesn't shrink existing history until each file is
  written again (Phase 7's lifecycle job could do it).

### Interview questions

1. What happens to the bytes when you DELETE an object in a versioned bucket?
2. How do you permanently delete an object from a versioned bucket?
3. How does S3 versioning differ from Git?
4. How would you restore a file to yesterday's version? Why copy rather than "move the pointer"?
5. Why keep versions in Postgres instead of asking S3 with ListObjectVersions?
6. Versioning is on and storage keeps growing. What are your options?
7. Why pin a presigned download to a version id?
