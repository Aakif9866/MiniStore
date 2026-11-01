# Phase 5 — Large Files

## BEFORE

### 1. The problem, measured

Uploads used `multer.memoryStorage()`: the whole file sits in Node's memory before going to MinIO.
Measured with [`scripts/measure-upload-memory.ts`](../backend/scripts/measure-upload-memory.ts):

| Upload | Peak memory growth |
|---|---|
| 100 MB | 279 MB |
| 300 MB | 605 MB |

About **2× the file size** (the buffer, plus copies made while sending it). Two people uploading a 1 GB
file at once would need ~4 GB of RAM, and the process would be killed.

### 2. Buffering vs streaming

```
buffering:  client ──▶ [ entire file in RAM ] ──▶ MinIO          memory ∝ file size
streaming:  client ──▶ [ 8 MiB part ] ──▶ MinIO                  memory ∝ part size × parts in flight
                       [ 8 MiB part ] ──▶ MinIO
```

### 3. S3 multipart upload

S3 can't accept a single PUT of unknown length, and a single PUT that fails at 99% starts from zero.
Multipart upload fixes both:

1. `CreateMultipartUpload` → upload ID
2. `UploadPart` × N (each ≥ 5 MiB except the last, uploaded in parallel, each retried on its own)
3. `CompleteMultipartUpload` → the object appears atomically
4. On failure: `AbortMultipartUpload`, or the parts stay on disk, invisible and still using space

`@aws-sdk/lib-storage`'s `Upload` does all four from a stream. Multipart ETags look like `<md5>-<parts>`,
not a plain MD5 of the content.

### 4. Design

```
request ──▶ busboy (multipart parser, streams; enforces byte limit)
              │ peek first 16 bytes → checkUpload (Phase 3: exe block, type sniff)
              ▼
            Upload (8 MiB parts, 4 in flight = ~32 MiB max buffered) ──▶ MinIO
```

The quota is now enforced **while streaming**: the byte limit for an upload is
`min(MAX_UPLOAD_BYTES, quota − used)`.

---

## AFTER

### Files

```
backend/src/upload-stream.ts     receiveUpload(): busboy → peek → checkUpload → lib-storage Upload
backend/src/routes/files.routes.ts   upload route now streams; multer removed
backend/scripts/measure-upload-memory.ts   memory experiment (dev DB, cleans up after itself)
backend/tests/integration/upload-stream.test.ts
```

Dependencies: `+busboy`, `+@aws-sdk/lib-storage`, `−multer`. Default `MAX_UPLOAD_BYTES` raised from
10 MiB to 1 GiB, since it no longer costs memory.

### Results

| Upload | Before (buffered) | After (streamed) | Throughput after |
|---|---|---|---|
| 100 MB | +279 MB | +118 MB | 106 MB/s |
| 300 MB | +605 MB | +181 MB | 103 MB/s |
| 1 GB | ~+2 GB (projected) | **+219 MB** | 97 MB/s |

Memory now grows slowly instead of in step with the file. The measurement runs the client in the same
process (Node's `fetch` reading the file from disk), so part of the remaining growth is the client, not
the server.

### Bugs found while building (real ones)

| Symptom | Cause | Fix |
|---|---|---|
| Over-quota 100-byte upload accepted (201) | busboy emitted `limit` while we were still peeking the first chunk; the listener was attached afterwards | Attach the `limit` listener before reading anything |
| Client got `EPIPE` instead of `413` | We replied while the client was still sending; Node then closed the socket | Drain the rest of the request, then reply. Browsers now show "File too large", not "network error" |
| A small over-limit file could finish as one PUT before the abort | `limit` fired after `done()` | Delete **that version** only (`deleteObject(key, versionId)`), never a plain delete |

### What the tests prove (57 passing, +4)

- 20 MiB file → ETag ends in `-3` (three 8 MiB parts) and the stored bytes match by SHA-256.
- Over the limit mid-stream → 413, no object, and **no leftover multipart uploads** in the bucket.
- **Client disconnects mid-upload** → no object and no leftover parts.
- Non-multipart body → 400.

### Retries

The S3 client retries each failed request up to 3 times with backoff (SDK default). With multipart, a
network blip costs one 8 MiB part, not the whole file. Resuming an upload after the *client* disconnects
needs the client to remember the upload ID and finished parts (the tus protocol or presigned multipart);
out of scope here (see Phase 15).

### Interview questions

1. Why does buffering an upload in memory break at scale? What did you measure?
2. Walk through an S3 multipart upload. What happens to parts if you never complete or abort it?
3. Why is the minimum part size 5 MiB? What's the maximum number of parts?
4. Why can't you check a file's type before you've received it? How do you do it while streaming?
5. Why doesn't a multipart ETag equal the MD5 of the file?
6. How do you enforce a size limit on a stream of unknown length?
7. What should the server do with the rest of the request body after rejecting an upload, and why?
