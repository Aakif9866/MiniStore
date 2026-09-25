# Phase 1 — Object Storage & MinIO

## BEFORE

### 1. Three kinds of storage

| | Block | File | Object |
|---|---|---|---|
| Unit | Fixed-size blocks (e.g. 4 KB), numbered | Files inside nested directories | Whole objects in a flat bucket |
| Addressed by | Block number | Path `/a/b/c.txt` | Key `a/b/c.txt` (just a string) |
| Accessed via | Disk driver (SATA, NVMe, iSCSI, EBS) | OS filesystem (ext4, NFS) | **HTTP API** (S3) |
| Edit in place? | Yes, any block | Yes, any byte | **No**. You replace the whole object |
| Good for | Databases, OS disks | Shared drives, apps expecting a filesystem | Files, images, backups, logs, datasets |
| Example | AWS EBS, a laptop SSD | NFS, AWS EFS | **S3, MinIO**, GCS, Azure Blob |

PostgreSQL runs on **block** storage because it rewrites small pages constantly. User files don't
need that. They're written once, read many times, and replaced whole. That's what object storage is
built for, and dropping in-place edits is what lets it scale so simply.

### 2. The vocabulary

- **Bucket**: a top-level container (`ministore-dev`). Permissions, versioning and lifecycle rules are set per bucket.
- **Object**: the bytes plus metadata. Maximum 5 TiB each in S3.
- **Key**: the object's full name within its bucket: `users/42/reports/2026/hello.txt`.
- **Prefix and "folders"**: **folders don't exist.** The key is one flat string. Tools split on `/`
  so it *looks* like folders. Listing with `prefix=users/42/` is a string match, not a directory read.
  So there's no "rename folder" operation: renaming means copying every object to a new key and deleting the old one.
- **Metadata**
  - *System*: `Content-Type`, `Content-Length`, `ETag`, `Last-Modified`.
  - *User*: any `X-Amz-Meta-*` header you set. Small (2 KB total) and **can't be searched**, which is why we still need Postgres.
- **ETag**: a fingerprint of the content. For a simple upload it's the MD5 of the bytes. For multipart uploads it isn't (Phase 5).

### 3. S3-compatible API

S3 is Amazon's HTTP API: `PUT /bucket/key` to upload, `GET /bucket/key` to download, `GET /bucket?list-type=2&prefix=…` to list.
It became the industry standard, so dozens of systems speak it: MinIO, Ceph, Cloudflare R2, Backblaze B2, Garage.
**Code written against the S3 API runs against any of them by changing the endpoint URL.**
That's why our backend will use the AWS S3 SDK, not a MinIO-specific library.

Every request is **signed** with the secret key (AWS Signature V4). The secret itself never crosses the network.
The server recomputes the signature and compares. Phase 4's presigned URLs are the same signature put in a URL.

### 4. Why companies use S3 / MinIO

- **Cheap per GB, and scales without planning.** You don't pick a disk size in advance.
- **Durable**: replicated or erasure-coded across disks and nodes (Phase 12).
- **Shared over HTTP**: any service, any language, anywhere can read it. Clients can download directly (Phase 4).
- **Built-in features**: versioning, lifecycle expiry, replication, event notifications.

**MinIO** = S3-compatible storage you run yourself: on-prem, air-gapped, local dev, or where cloud cost or data residency rules out AWS.

### 5. MinIO architecture, briefly

- One Go binary. `minio server /data` turns a directory into S3 storage.
- **Stateless in memory. Everything is on disk.** Each object becomes a directory holding `xl.meta`
  (metadata; tiny objects are stored inside it too) and, for bigger objects, data part files.
  Never edit `/data` by hand. Always go through the API.
- There's no central metadata database. The disks *are* the database. That's the main difference from Postgres.
- Single-node now. Distributed mode with **erasure coding** (spreading data and parity across drives and nodes) comes in Phase 12.
- Two ports: **9000** = S3 API, **9001** = web Console.

### 6. MinIO vs PostgreSQL — and why files don't go in Postgres

| | PostgreSQL | MinIO |
|---|---|---|
| Stores | Rows: small, structured, related | Blobs: large, opaque bytes |
| Queries | `WHERE`, `JOIN`, indexes, aggregates | Get by key, list by prefix. That's it. |
| Transactions | Yes (ACID across rows) | Per object only |
| Scaling | Vertical, plus read replicas | Add disks or nodes, roughly linearly |

Putting a 500 MB file in a Postgres `bytea` column:
- The **backup** now includes every file, so `pg_dump` takes hours, not seconds.
- The **WAL and replication** stream carries every upload, so replicas fall behind.
- **Memory**: a `bytea` value is read and returned whole (limit 1 GB), so there's no range read or streaming.
- The **connection pool** is held for the full transfer. Ten slow downloads can starve every other query.
- **Cost**: database-grade SSD per GB is far more expensive than object storage.

So Postgres stores the *pointer* (`bucket`, `object_key`) and the facts. MinIO stores the bytes.

### 7. Access keys and policies

- **Access key**: a public ID, sent with every request (like a username).
- **Secret key**: used to *sign* requests and never sent (like a password).
- **Root user** (`MINIO_ROOT_USER`/`PASSWORD`): can do everything. Treat it like the Postgres superuser.
- **App user** (`ministore-app`): what the backend will use. Its **IAM policy** only allows
  object read, write and delete in `ministore-dev`. It can't create buckets or manage users.
  **Least privilege:** if the backend is compromised, the damage stays in one bucket.

Two kinds of policy:

| | IAM (user) policy | Bucket policy |
|---|---|---|
| Attached to | A user or group | A bucket |
| Answers | "What can *this user* do?" | "Who can do what *to this bucket*?" (including anonymous) |
| We use it for | `ministore-app` permissions | Nothing. The bucket stays private. |
| `mc` command | `mc admin policy …` | `mc anonymous …` |

Default is **deny**: a request succeeds only if some policy allows it.

### 8. What we're building in this phase

```
Your Mac                        Docker network "ministore_default"
─────────                       ─────────────────────────────────────
browser  ─ 127.0.0.1:9101 ─▶  minio:9001  Console ┐
curl/SDK ─ 127.0.0.1:9100 ─▶  minio:9000  S3 API  ├─ volume ministore_minio-data → /data
                                minio-init (runs once, exits)     ┘
                                mc (on demand: docker compose run --rm mc …)
```

- Host ports are **9100/9101** instead of the defaults 9000/9001, so they don't collide with other local services.
  They're set in `.env` (`MINIO_API_PORT`, `MINIO_CONSOLE_PORT`).
- Ports are bound to `127.0.0.1`, so other machines on your Wi-Fi can't reach MinIO.
- `minio-init` creates the bucket, the `ministore-app` policy and the app user. It's idempotent.

---

## AFTER

### Files added

| File | Purpose |
|---|---|
| [`docker-compose.yml`](../docker-compose.yml) | MinIO server, init job, `mc` tool container, persistent volume |
| [`infra/minio/init.sh`](../infra/minio/init.sh) | Bucket, least-privilege policy, and app user |
| [`.env.example`](../.env.example) | All settings, with explanations. Copy it to `.env` (git-ignored) |

### Run it

```bash
cp .env.example .env               # then replace both passwords:  openssl rand -hex 20
docker compose up -d               # starts minio, then minio-init runs and exits
docker compose ps -a               # minio: healthy · minio-init: Exited (0)
docker compose logs minio-init     # shows bucket/user/policy creation
```

Console: http://127.0.0.1:9101. Log in with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from `.env`.

### Using `mc` (no install needed; it runs in a container)

`./playground/` on your Mac is `/playground` inside the mc container. Put files there to upload them.

```bash
alias mc='docker compose run --rm mc'        # optional convenience for this shell

mc ls local                                   # buckets (as root)
mc cp --attr "X-Amz-Meta-Owner=user-42" hello.txt local/ministore-dev/users/42/hello.txt
mc ls --recursive local/ministore-dev/        # all keys
mc stat local/ministore-dev/users/42/hello.txt   # size, ETag, metadata
mc cat  local/ministore-dev/users/42/hello.txt
mc rm   local/ministore-dev/users/42/hello.txt

mc ls app/ministore-dev                       # same, as the restricted app user
mc admin user list local                      # admin ops: root only
mc anonymous get local/ministore-dev          # bucket policy (should be "private")
```

### What we observed (real output from this setup)

| Experiment | Result | Why |
|---|---|---|
| Upload with `X-Amz-Meta-Owner` | `mc stat` shows it plus `ETag 6950c888…` | User metadata travels as HTTP headers. ETag = MD5 of the 21 bytes |
| `mc ls ministore-dev/` | Shows `users/` with size 0B | No folder object exists. `mc` groups keys by `/` |
| App user `mc mb` / `mc admin user list` | `Access Denied` | Its policy has no bucket-create or admin actions |
| Anonymous `curl` of the object | `403 AccessDenied` | Bucket is private and nothing allows anonymous access |
| `mc anonymous set download …/users/42/reports/` | `curl` → `200`, then `403` after `set none` | A bucket policy with `Principal: *` opened **just that prefix** |
| Look inside `/data` | `hello.txt/` is a **directory** containing `xl.meta` | MinIO's own on-disk format. Small objects are inlined into the metadata file |
| `docker compose down` → `up` | Object still there | Named volume `ministore_minio-data` outlives containers |
| Console API `users`/`policies` | `404`. Only the object browser exists | MinIO removed admin screens from the community Console in 2025. **Use `mc admin` for users and policies** |

### Break it yourself (5 minutes)

1. `docker compose down -v`, then `up -d`. Everything is gone, including the bucket and user. `-v` deletes the volume. **Never type this in production.**
   Recover: `up` re-runs `minio-init`, so bucket and user come back. Objects don't. (That's what Phase 11 backups are for.)
2. Set `MINIO_ROOT_PASSWORD=short` in `.env` and run `up -d`. MinIO refuses to start (minimum 8 characters). Check `docker compose logs minio`.
3. `mc ls app/some-other-bucket`: Access Denied, even though you're authenticated. **Authentication ≠ authorization.**
   Compare with `mc ls local/some-other-bucket`: root gets "does not exist". The restricted user can't even learn
   whether another bucket exists, because the denial doesn't leak information.

### Why this image (a real-world lesson)

MinIO stopped publishing community binaries and images in Oct 2025, and deleted `minio/minio` from Docker Hub on
**11 Sep 2026**. `quay.io/minio/*` now requires authentication. We use **`cgr.dev/chainguard/minio`**: Chainguard's free
build from MinIO's AGPL source. It runs as non-root (uid 65532), has no package manager, and includes `mc`.
It's **pinned by digest** (`@sha256:…`) because Chainguard's free tier only offers `:latest`, and `:latest` changes under you.

Lesson: an infrastructure dependency can disappear. Because our code will speak the **S3 API**, not "MinIO",
we could swap to Garage, SeaweedFS or AWS S3 by changing an endpoint. This is recorded as a risk for Phase 15.

To update the image later: `docker pull cgr.dev/chainguard/minio:latest`, read the new digest with
`docker inspect --format '{{index .RepoDigests 0}}' cgr.dev/chainguard/minio:latest`, and replace it in `docker-compose.yml`.

### Interview questions

1. Your team wants to store user uploads in a Postgres `bytea` column. Give three concrete problems.
2. What is an object key, and why is "rename a folder" expensive in S3?
3. What's the difference between an IAM policy and a bucket policy? Which would you use to make one prefix public?
4. The backend's MinIO credentials leak. With our setup, what can an attacker do and not do?
5. What does the secret key do if it's never sent over the network?
6. `docker compose down` vs `docker compose down -v`: what survives each?
7. Why bind ports to `127.0.0.1` instead of `0.0.0.0`?
8. Why pin a container image by digest instead of a tag?
9. MinIO's images were withdrawn. What in our design limits the damage, and what would you still have to change?

### Open going into Phase 2

- Postgres will use host port **5433** instead of the default 5432, for the same reason.
- The versioning actions (`s3:GetObjectVersion` etc.) aren't in the app policy yet. We'll add them in Phase 6 when we need them.
