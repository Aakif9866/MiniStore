# Phase 2 — Backend Integration

## BEFORE

### 1. What we're adding

```
Client ──HTTP──▶ Express API (host, :3000) ──SQL──▶ PostgreSQL (docker, :5433)  metadata
                                             └──S3──▶ MinIO      (docker, :9100)  bytes
```

The backend runs on your Mac (`npm run dev`) for fast reloads. Postgres and MinIO run in Docker.
The backend gets its own Docker image later, when we load-test and build CI.

### 2. Components and why each exists

| Piece | Problem it solves | Alternatives | Trade-off we accept |
|---|---|---|---|
| **Express 5** | Routing and middleware. v5 forwards errors from `async` handlers automatically | Fastify (faster), NestJS (more structure) | Not the fastest, but the most familiar |
| **Prisma 7** | Typed queries, schema → SQL migrations | Sequelize, Knex, raw `pg` | v7 needs a driver adapter (`@prisma/adapter-pg`) and a separate `prisma.config.ts` |
| **zod** | Validates request bodies and env vars at runtime. TypeScript types vanish at runtime | joi, express-validator | One more dependency |
| **JWT** (HS256) | Stateless login: any instance verifies with the shared secret, no session store | Sessions + Redis | Can't revoke a token before it expires (1h). Revocation needs a denylist, i.e. state again |
| **scrypt** (Node built-in) | Password hashing that's slow *and* memory-hungry, so brute force is expensive | bcrypt, argon2 (native module) | 32 MiB RAM per login. That matters under load (Phase 9) |
| **AWS SDK v3** | Speaks S3 to MinIO. Only the endpoint is MinIO-specific | `minio` npm package | Bigger package, but portable to any S3 |
| **multer** (memory) | Parses `multipart/form-data` uploads | busboy (streaming) | **Buffers the whole file in RAM.** Deliberate for now, fixed in Phase 5 |

### 3. Schema

```
users                               files
─────                               ─────
id            uuid PK        ┌───── user_id        uuid FK → users.id (RESTRICT)
email         text UNIQUE    │      id             uuid PK
password_hash text           │      original_name  text      ← display only, never used as a path
created_at    timestamp  ────┘      object_key     text UNIQUE ← users/<userId>/<uuid>
                                    bucket         text
                                    mime_type      text
                                    size           bigint    ← int would cap at 2 GiB
                                    etag           text      ← MD5 of content (single-part upload)
                                    version_id     text NULL ← Phase 6
                                    created_at, updated_at
                                    INDEX (user_id, created_at) ← serves "list my files, newest first"
```

### 4. Request flow: upload

```
POST /files/upload  (Authorization: Bearer <jwt>, multipart field "file")
 1. requireAuth   verify JWT signature + expiry → req.userId          fail → 401
 2. multer        parse multipart, enforce size limit                 fail → 413 / 400
 3. key           users/<userId>/<random uuid>   (user's filename NOT used)
 4. MinIO         PutObject(key, bytes)  → ETag                        fail → 500, nothing saved
 5. Postgres      INSERT files row                                     fail → delete object, 500
 6. response      201 + metadata (no bucket, key or user id exposed)
```

Download: auth → `SELECT … WHERE id = ? AND user_id = ?` → `GetObject` → **stream** chunks to the client.
Delete: auth → ownership check → delete **row**, then **object**. If the object delete fails, that's an orphan, which is harmless.

### 5. Security choices built in from the start

- **Ownership in the query**: `WHERE id = :id AND user_id = :me`. Someone else's file returns **404, not 403**, so an attacker can't tell whether an ID exists.
- **Keys we generate**: a filename like `../../etc/passwd` is just a string in a column.
- **Same 401 for wrong password and unknown email**, and a dummy hash comparison keeps the timing the same.
- **JWT algorithm pinned** to HS256 when verifying, so the token can't pick its own algorithm.
- **Errors**: known errors get a clear message. Unknown errors are logged server-side and the client sees only `Internal server error`.
- **Config validated at startup**: a missing `JWT_SECRET` means the process refuses to boot, rather than failing on the first request.

Phase 3 adds MIME validation, filename sanitising, rate limiting and a review of all of this.

---

## AFTER

### Files

```
backend/
├── prisma/schema.prisma, prisma/migrations/   tables + generated SQL
├── prisma.config.ts                            Prisma 7 CLI config (reads ../.env)
├── src/
│   ├── config.ts        env → validated, typed config
│   ├── db.ts            one PrismaClient (connection pool) per process
│   ├── storage.ts       S3 client + put/get/delete
│   ├── auth.ts          scrypt hashing, JWT sign, requireAuth middleware
│   ├── errors.ts        HttpError + central error handler
│   ├── routes/          auth.routes.ts, files.routes.ts
│   ├── app.ts           builds the Express app (used by tests)
│   └── server.ts        listens + graceful shutdown
└── tests/               unit + integration (real Postgres + MinIO)
```

### Run it

```bash
docker compose up -d                  # minio, minio-init, postgres
cd backend
npm install                           # also runs `prisma generate`
npm run db:migrate                    # apply migrations to the dev DB
npm run dev                           # http://127.0.0.1:3000, reloads on save
npm test                              # 23 tests against the ministore_test DB
```

### Try it with curl

```bash
B=http://localhost:3000
curl -XPOST $B/auth/register -H 'content-type: application/json' -d '{"email":"me@x.io","password":"password-123"}'
T=$(curl -s -XPOST $B/auth/login -H 'content-type: application/json' -d '{"email":"me@x.io","password":"password-123"}' | jq -r .token)
curl -H "Authorization: Bearer $T" -F "file=@some.pdf" $B/files/upload
curl -H "Authorization: Bearer $T" $B/files
curl -H "Authorization: Bearer $T" -OJ $B/files/<id>/download     # -OJ saves using the server's filename
curl -H "Authorization: Bearer $T" -XDELETE $B/files/<id>
```

### API

| Method | Path | Auth | Success | Errors |
|---|---|---|---|---|
| POST | `/auth/register` | – | 201 `{id,email}` | 400 invalid, 409 email taken |
| POST | `/auth/login` | – | 200 `{token}` | 400, 401 |
| POST | `/files/upload` | ✔ | 201 file metadata | 400 no file, 413 too large |
| GET | `/files` | ✔ | 200 list (newest 100) | |
| GET | `/files/:id` | ✔ | 200 metadata | 404 |
| GET | `/files/:id/download` | ✔ | 200 bytes, `Content-Disposition: attachment` | 404 |
| DELETE | `/files/:id` | ✔ | 204 | 404 |
| GET | `/health` | – | 200 | |

(Swagger/OpenAPI docs are added once the API settles after Phase 4.)

### What the tests prove (23 passing)

- Exact bytes round-trip (SHA-compared), and the row and object are created and removed together.
- Bob gets 404 on all four routes for Alice's file, and his failed delete leaves it intact.
- `../../etc/passwd` and `résumé 日本.txt` are stored safely and exactly.
- 413 over the limit with **nothing** stored. Malformed JSON gives 400, bad UUID gives 404.
- **If the Postgres insert fails, the uploaded object is deleted** (Prisma is mocked to fail on purpose).
- Tests refuse to run unless the DB name ends in `_test`, because they `TRUNCATE` tables.

### Bugs found while building (real ones)

| Symptom | Cause | Fix |
|---|---|---|
| `résumé.txt` saved as `rÃ©sumÃ©.txt` | multer decodes filenames as Latin-1 by default | `defParamCharset: "utf8"` |
| `"  Alice@X.com "` rejected with 400 | Email validated *before* trimming | trim + lowercase, **then** validate (`pipe`) |
| Jest: `Cannot find module './internal/class.js'` | TS rewrites Prisma's `.ts` imports to `.js`, which don't exist in source | Jest `moduleNameMapper` strips `.js` |
| Jest: `dynamic import … without --experimental-vm-modules` | Prisma 7 loads its query engine with `import()` | `NODE_OPTIONS=--experimental-vm-modules` in `npm test` |

### Break it: what happened

| Failure | User sees | Server log | Recovery |
|---|---|---|---|
| MinIO stopped, upload | `500 Internal server error` in 0.19 s | `ECONNREFUSED 127.0.0.1:9100` | Automatic once MinIO is back |
| MinIO stopped, list files | **200**, still works | none | Listing only touches Postgres |
| Postgres stopped, login or list | `500` in ~5 ms | Prisma `P1001` (can't reach DB) | Automatic, because the pool reconnects |
| Postgres stopped, `/health` | **200 "ok"** ❌ | none | The health check lies |

**Why it matters:** a load balancer trusting `/health` would keep sending traffic to an instance that can't serve anything.
`/health` is a *liveness* check ("is the process up?"). We also need a *readiness* check ("can it do its job?")
that pings Postgres and MinIO. Planned for Phase 8/10. The two failures also both return a generic 500. Phase 10
turns "dependency down" into `503 Service Unavailable` with a `Retry-After` header.

### Known limitations (on purpose, each has a phase)

- Upload buffered in RAM (multer memory) → **Phase 5**
- No MIME allow-list, rate limiting, or filename sanitising → **Phase 3**
- No presigned URLs; every download streams through the backend → **Phase 4**
- `GET /files` capped at 100, no pagination
- Node 20 is end-of-life. The AWS SDK warns it will require Node ≥ 22 from January 2027. Use Node 22/24 when convenient.

### Interview questions

1. Walk through what happens, in order, when a user uploads a file. What happens at each failure point?
2. Why delete the Postgres row before the MinIO object, and not the other way round?
3. Why return 404 instead of 403 when a user requests someone else's file?
4. Why store `original_name` and generate `object_key` separately?
5. Why check email uniqueness with a UNIQUE constraint instead of a `SELECT` before the `INSERT`?
6. What's the downside of JWTs compared with server-side sessions? How would you log a user out everywhere?
7. Why is scrypt/bcrypt used for passwords instead of SHA-256?
8. Why is `size` a `BIGINT`?
9. Why must the backend stream downloads instead of loading the object into memory first?
10. `/health` returned 200 while Postgres was down. What's wrong with that, and what would you add?
