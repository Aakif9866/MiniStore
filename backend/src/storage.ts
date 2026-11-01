import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config";
import { s3Duration } from "./observability";

// The standard AWS SDK. Nothing here is MinIO-specific except the endpoint, so switching to
// AWS S3 (or another S3-compatible store) is a config change.
const clientOptions = {
  region: config.S3_REGION, // MinIO ignores it, but request signing requires one
  // Path-style: http://host/bucket/key. AWS defaults to virtual-hosted http://bucket.host/key,
  // which would need DNS for every bucket name — not available on localhost.
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.MINIO_APP_ACCESS_KEY,
    secretAccessKey: config.MINIO_APP_SECRET_KEY,
  },
};
export const s3 = new S3Client({ ...clientOptions, endpoint: config.S3_ENDPOINT });

// Time every S3 call (PutObject, UploadPart, GetObject, …) in one place: SDK middleware wraps them all.
s3.middlewareStack.add(
  (next, context) => async (args) => {
    const stop = s3Duration.startTimer({ operation: context.commandName });
    try {
      const out = await next(args);
      stop({ outcome: "ok" });
      return out;
    } catch (err) {
      stop({ outcome: "error" });
      throw err;
    }
  },
  { step: "initialize", name: "ministoreMetrics" },
);
// Signing is local maths (no network call), but the signature covers the host, so presigned URLs
// must be made with the endpoint the browser will use.
const presigner = new S3Client({
  ...clientOptions,
  endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT,
});

export const bucket = config.MINIO_BUCKET;

export async function putObject(key: string, body: Buffer, contentType: string) {
  const res = await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
  return {
    etag: (res.ETag ?? "").replaceAll('"', ""), // S3 returns the ETag wrapped in quotes
    versionId: res.VersionId ?? null, // only set once bucket versioning is on (Phase 6)
  };
}

export async function getObject(key: string, versionId?: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  // In Node the body is a stream: bytes arrive as MinIO sends them, not all at once.
  return { body: res.Body as Readable, contentLength: res.ContentLength };
}

export async function deleteObject(key: string, versionId?: string) {
  // S3 DELETE is idempotent: deleting a missing key still succeeds.
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
}

/**
 * A URL that lets whoever holds it GET this one object until it expires — no credentials needed.
 * The response headers are part of the signature, so the client can't turn the download into an
 * inline render (attachment) or change the Content-Type.
 */
export function presignDownload(
  key: string,
  filename: string,
  contentType: string,
  ttlSeconds: number,
  versionId?: string,
) {
  return getSignedUrl(
    presigner,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      ResponseContentType: contentType,
    }),
    { expiresIn: ttlSeconds },
  );
}

/** Make an old version current again: S3 copies it on top of the key as a brand-new version. */
export async function copyVersion(key: string, versionId: string) {
  const res = await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: `${bucket}/${encodeURIComponent(key)}?versionId=${encodeURIComponent(versionId)}`,
    }),
  );
  return {
    etag: (res.CopyObjectResult?.ETag ?? "").replaceAll('"', ""),
    versionId: res.VersionId ?? null,
  };
}

/**
 * Permanently remove a key: every version and every delete marker. With versioning on, a plain
 * DeleteObject only hides the object behind a marker — the bytes (and the storage bill) remain.
 */
export async function purgeObject(key: string) {
  let KeyMarker: string | undefined;
  let VersionIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker, VersionIdMarker }),
    );
    const targets = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((v) => v.Key === key) // Prefix also matches "key-something"
      .map((v) => ({ Key: key, VersionId: v.VersionId }));
    if (targets.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: targets, Quiet: true } }));
    }
    ({ NextKeyMarker: KeyMarker, NextVersionIdMarker: VersionIdMarker } = page);
    if (!page.IsTruncated) break;
  } while (true);
}
