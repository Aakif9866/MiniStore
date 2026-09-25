import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "./config";

// The standard AWS SDK. Nothing here is MinIO-specific except the endpoint, so switching to
// AWS S3 (or another S3-compatible store) is a config change.
export const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION, // MinIO ignores it, but request signing requires one
  // Path-style: http://host/bucket/key. AWS defaults to virtual-hosted http://bucket.host/key,
  // which would need DNS for every bucket name — not available on localhost.
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.MINIO_APP_ACCESS_KEY,
    secretAccessKey: config.MINIO_APP_SECRET_KEY,
  },
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

export async function getObject(key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  // In Node the body is a stream: bytes arrive as MinIO sends them, not all at once.
  return { body: res.Body as Readable, contentLength: res.ContentLength };
}

export async function deleteObject(key: string) {
  // S3 DELETE is idempotent: deleting a missing key still succeeds.
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
