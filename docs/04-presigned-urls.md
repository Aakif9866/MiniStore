# Phase 4 — Presigned URLs

## BEFORE

### 1. The problem

Every download streams through the API: MinIO → Node → client. For a 2 GB file the API holds a
connection open for minutes and pays the bandwidth twice. At scale the API becomes a very expensive
proxy.

### 2. What a presigned URL is

A normal S3 request is signed with the secret key in an `Authorization` header (AWS Signature V4).
A **presigned URL** moves that signature into the query string:

```
http://127.0.0.1:9100/ministore-dev/users/<uid>/<uuid>
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=ministore-app/20261101/us-east-1/s3/aws4_request   ← who signed (access key, not secret)
  &X-Amz-Date=20261101T140000Z
  &X-Amz-Expires=300                                                   ← valid for 5 minutes
  &X-Amz-SignedHeaders=host
  &response-content-disposition=attachment...                          ← forced download, signed
  &X-Amz-Signature=3f1c…                                               ← HMAC over all of the above
```

MinIO recomputes the HMAC with the secret it shares with us. Change **any** signed part (the key, the
expiry, the response headers) and the signature no longer matches → `403`. After `X-Amz-Expires`, → `403`.
Making a URL is pure local maths; the API never contacts MinIO to create one.

### 3. Flow

```
Browser ──GET /files/:id/download-url──▶ API   (JWT + ownership check, as before)
        ◀── { url, expiresAt } ─────────
Browser ──GET <url>─────────────────────▶ MinIO (no JWT; the signature is the permission)
        ◀── bytes, Content-Disposition: attachment
```

### 4. Risks and decisions

| Risk | Decision |
|---|---|
| A leaked URL works for anyone until it expires | Short TTL: **5 minutes** (`PRESIGN_TTL_SECONDS`, max 1 h) |
| Browser renders HTML/SVG inline from MinIO's origin | `response-content-disposition=attachment` and `response-content-type` are **inside the signature** |
| URL signed for a host the browser can't reach | Separate `S3_PUBLIC_ENDPOINT` for signing; the host is part of the signature |
| Presigned **uploads** skip our checks (exe blocking, sniffing, quota) | **Not done.** Uploads stay through the API so Phase 3's checks still apply |

---

## AFTER

### Files

```
backend/src/storage.ts       presignDownload(): separate S3 client using S3_PUBLIC_ENDPOINT
backend/src/routes/files.routes.ts   GET /files/:id/download-url → { url, expiresAt }
backend/tests/integration/presign.test.ts
frontend/src/api.ts          download() now asks for a URL and navigates to it
```

New dependency: `@aws-sdk/s3-request-presigner` (official, same version as the S3 client).
The old streaming route `GET /files/:id/download` stays for clients that can't follow a redirect.

### What the tests prove (53 passing, +4)

- A plain `fetch(url)` with **no credentials** gets the exact bytes and `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`.
- Bob gets 404 when asking for a URL to Alice's file — ownership is still checked before signing.
- Changing the key in the URL → 403. Changing `attachment` to `inline` → 403.
- A URL signed for 1 second works at once and returns 403 after 2 seconds.

### Frontend change

`download()` used to fetch the whole file into a Blob in browser memory. Now it fetches a URL and does
`window.location.assign(url)`. MinIO's `attachment` header makes the browser save the file without leaving
the page, and the download shows in the browser's own download manager with real progress.

### Why presigned uploads were skipped (on purpose)

A presigned PUT would let the browser upload straight to MinIO, but then the API never sees the bytes:
no executable check, no sniffing, and quota can only be checked after the fact. Doing it safely needs a
**"pending → verify → commit"** flow: upload to a `pending/` prefix, then an API call that inspects the
object (HEAD + first bytes) and either moves it in or deletes it, plus a lifecycle rule to clean
abandoned pending objects. Worth it for multi-GB uploads at scale; listed in Phase 15.

### Interview questions

1. How does MinIO verify a presigned URL without calling your backend?
2. What exactly is signed? What happens if someone edits the expiry in the URL?
3. Why does the presigned URL need to be signed for the *public* hostname?
4. A presigned URL leaks into a chat. What's the damage and how do you limit it?
5. Why force `Content-Disposition: attachment` through the signature?
6. Why might you NOT want presigned uploads, and how would you make them safe?
7. Presigned URL vs a CDN signed cookie: when would you use each?
