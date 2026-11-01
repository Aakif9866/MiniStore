import { Readable } from "node:stream";
import { Upload } from "@aws-sdk/lib-storage";
import busboy from "busboy";
import type { Request } from "express";
import { HttpError } from "./errors";
import { uploadedBytes } from "./observability";
import { bucket, deleteObject, s3 } from "./storage";
import { checkUpload, sanitizeFilename, SNIFF_BYTES } from "./upload-policy";

export type Received = { name: string; mimeType: string; size: number; etag: string; versionId: string | null };

// S3 multipart: parts of 8 MiB, 4 in flight → at most ~32 MiB buffered per upload, whatever the file size.
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 4;

/**
 * Stream the multipart field "file" from the request straight into MinIO at `key`.
 * Memory use is bounded by the part buffers, not by the file size.
 *
 * `maxBytes` is enforced while streaming; when it's crossed the S3 upload is aborted (no partial
 * object is left behind) and `tooLarge` is thrown.
 */
export function receiveUpload(req: Request, key: string, maxBytes: number, tooLarge: HttpError): Promise<Received> {
  if (!req.is("multipart/form-data")) {
    return Promise.reject(new HttpError(400, 'Send the file as multipart/form-data field "file"'));
  }

  return new Promise<Received>((resolve, reject) => {
    let gotFile = false;
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: maxBytes, files: 1, fields: 10, parts: 20 },
      defParamCharset: "utf8", // browsers send UTF-8 filenames; the default (latin1) mangles "é"
    });

    // Answer only after the client has finished sending. Replying mid-upload makes most clients
    // (browsers included) see a reset connection instead of our 413/415 message. Draining is
    // bounded by the server's request timeout, and the bytes are discarded, not stored.
    const fail = (err: unknown) => {
      req.unpipe(bb);
      req.resume();
      if (req.readableEnded) return reject(err);
      req.once("end", () => reject(err));
      req.once("close", () => reject(err)); // client gave up: nobody to answer, just clean up
    };

    bb.on("file", (field, file, info) => {
      if (field !== "file" || gotFile) return file.resume(); // ignore anything else
      gotFile = true;
      handleFile(file, info).then(resolve, fail);
    });
    bb.on("close", () => {
      if (!gotFile) reject(new HttpError(400, 'Send the file as multipart/form-data field "file"'));
    });
    bb.on("error", () => fail(new HttpError(400, "Malformed multipart body")));
    req.pipe(bb);
  });

  async function handleFile(file: Readable, info: busboy.FileInfo): Promise<Received> {
    const name = sanitizeFilename(info.filename ?? "");
    // Listen BEFORE reading anything: for a small file busboy can hit the limit (and emit this)
    // while we're still peeking at the first chunk.
    let truncated = false;
    let upload: Upload | undefined;
    file.on("limit", () => {
      truncated = true;
      void upload?.abort();
    });

    // Peek at the first bytes to decide the type, then replay them in front of the rest.
    const chunks = file[Symbol.asyncIterator]();
    const head: Buffer[] = [];
    let headLength = 0;
    while (headLength < SNIFF_BYTES) {
      const next = await chunks.next();
      if (next.done) break;
      head.push(next.value);
      headLength += next.value.length;
    }
    const mimeType = checkUpload(name, Buffer.concat(head), info.mimeType); // throws 415

    let size = 0;
    const body = Readable.from(
      (async function* () {
        for (const c of head) yield c;
        for (let n = await chunks.next(); !n.done; n = await chunks.next()) yield n.value;
      })(),
    ).on("data", (c: Buffer) => (size += c.length));

    if (truncated) throw tooLarge; // over the limit before we even started sending
    upload = new Upload({
      client: s3,
      params: { Bucket: bucket, Key: key, Body: body, ContentType: mimeType },
      partSize: PART_SIZE,
      queueSize: QUEUE_SIZE,
      leavePartsOnError: false, // abort the multipart upload so no invisible parts keep using disk
    });
    let out;
    try {
      out = await upload.done();
    } catch (err) {
      if (truncated) throw tooLarge; // aborted mid-way: S3 discarded the parts
      throw err;
    }
    if (truncated) {
      // The limit fired after a small file had already completed as a single PUT: remove exactly
      // that version (never a plain delete, which could hide an older version in Phase 6).
      await deleteObject(key, out.VersionId).catch(() => {});
      throw tooLarge;
    }
    uploadedBytes.inc(size);
    return {
      name,
      mimeType,
      size,
      etag: (out.ETag ?? "").replaceAll('"', ""),
      versionId: out.VersionId ?? null,
    };
  }
}
