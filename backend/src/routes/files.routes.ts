import { randomUUID } from "node:crypto";
import { logger } from "../observability";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { config } from "../config";
import { prisma } from "../db";
import { HttpError } from "../errors";
import type { File, FileVersion } from "../generated/prisma/client";
import { purgeFile, trimHistory } from "../file-service";
import { bucket, copyVersion, deleteObject, getObject, presignDownload } from "../storage";
import { receiveUpload } from "../upload-stream";

export const filesRouter = Router();
filesRouter.use(requireAuth);

const idParam = z.object({ id: z.uuid() });

/**
 * Find a file only if it belongs to the caller. Not-yours and doesn't-exist both give 404.
 * Trashed files are invisible to every route except the /trash ones.
 */
async function findOwnedFile(userId: string, params: unknown, { trashed = false } = {}): Promise<File> {
  const parsed = idParam.safeParse(params);
  const file = parsed.success
    ? await prisma.file.findFirst({
        where: { id: parsed.data.id, userId, deletedAt: trashed ? { not: null } : null },
      })
    : null;
  if (!file) throw new HttpError(404, "File not found");
  return file;
}

/** API shape. Internal details (bucket, object key, user id) stay on the server. */
function toDto(f: File) {
  return {
    id: f.id,
    name: f.originalName,
    mimeType: f.mimeType,
    size: Number(f.size), // BigInt can't be JSON-serialised; safe up to 8 PiB
    etag: f.etag,
    versionId: f.versionId,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

function toTrashDto(f: File) {
  const purgeAt = new Date(f.deletedAt!.getTime() + config.TRASH_RETENTION_DAYS * 86_400_000);
  return { ...toDto(f), deletedAt: f.deletedAt, purgeAt };
}

/**
 * How many bytes this user may still upload, and which error to give when a stream crosses it.
 * The quota is enforced WHILE streaming: the limit for one upload is whatever is left.
 * ponytail: two concurrent uploads each see the same "left" and can overshoot by one file.
 * A per-user lock (or SELECT … FOR UPDATE) closes it if exact quotas ever matter.
 */
async function uploadLimit(userId: string) {
  const left = config.MAX_USER_STORAGE_BYTES - (await usedBytes(userId));
  if (left <= 0) throw new HttpError(403, "Storage quota exceeded");
  const overQuota = left < config.MAX_UPLOAD_BYTES;
  return {
    limit: Math.min(left, config.MAX_UPLOAD_BYTES),
    tooLarge: overQuota ? new HttpError(403, "Storage quota exceeded") : new HttpError(413, "File too large"),
  };
}

/** Quota counts every stored version (trash included), not just current ones: they all use disk. */
async function usedBytes(userId: string): Promise<number> {
  const { _sum } = await prisma.fileVersion.aggregate({ where: { file: { userId } }, _sum: { size: true } });
  return Number(_sum.size ?? 0);
}

filesRouter.post("/upload", async (req, res) => {
  const userId = req.userId!;
  const { limit, tooLarge } = await uploadLimit(userId);

  // We choose the key. The user's filename is only stored as metadata, so it can never
  // cause path traversal or overwrite someone else's object.
  const objectKey = `users/${userId}/${randomUUID()}`;

  // Step 1: bytes → MinIO, streamed in parts (never the whole file in memory).
  const up = await receiveUpload(req, objectKey, limit, tooLarge);

  // Step 2: metadata → Postgres. If this fails, the object from step 1 is an orphan:
  // try to remove it, and if even that fails it stays orphaned (harmless, cleanable later).
  try {
    const file = await prisma.file.create({
      data: {
        userId,
        originalName: up.name,
        objectKey,
        bucket,
        mimeType: up.mimeType,
        size: BigInt(up.size),
        etag: up.etag,
        versionId: up.versionId,
        versions: { create: versionData(up) },
      },
    });
    res.status(201).json(toDto(file));
  } catch (err) {
    await deleteObject(objectKey, up.versionId ?? undefined).catch((e) =>
      logger.error({ err: e }, `Orphaned object ${objectKey}: cleanup failed`),
    );
    throw err;
  }
});

// Registered before "/:id" so "usage" isn't treated as a file id.
filesRouter.get("/usage", async (req, res) => {
  const userId = req.userId!;
  res.json({
    usedBytes: await usedBytes(userId),
    quotaBytes: config.MAX_USER_STORAGE_BYTES,
    fileCount: await prisma.file.count({ where: { userId, deletedAt: null } }),
  });
});

filesRouter.get("/", async (req, res) => {
  const files = await prisma.file.findMany({
    where: { userId: req.userId!, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 100, // pagination comes later; never return an unbounded list
  });
  res.json(files.map(toDto));
});

// ---------- Trash (Phase 7) ----------
// Registered before "/:id" routes so "trash" isn't parsed as a file id.

filesRouter.get("/trash", async (req, res) => {
  const files = await prisma.file.findMany({
    where: { userId: req.userId!, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    take: 100,
  });
  res.json(files.map(toTrashDto));
});

filesRouter.post("/trash/:id/restore", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params, { trashed: true });
  res.json(toDto(await prisma.file.update({ where: { id: file.id }, data: { deletedAt: null } })));
});

filesRouter.delete("/trash/:id", async (req, res) => {
  await purgeFile(await findOwnedFile(req.userId!, req.params, { trashed: true }));
  res.status(204).end();
});

// Empty the trash.
filesRouter.delete("/trash", async (req, res) => {
  const files = await prisma.file.findMany({
    where: { userId: req.userId!, deletedAt: { not: null } },
    select: { id: true, objectKey: true },
  });
  for (const f of files) await purgeFile(f);
  res.status(204).end();
});

filesRouter.get("/:id", async (req, res) => {
  res.json(toDto(await findOwnedFile(req.userId!, req.params)));
});

// "Delete" moves to the trash: reversible until TRASH_RETENTION_DAYS, then purged by the lifecycle job.
filesRouter.delete("/:id", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);
  await prisma.file.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
  res.status(204).end();
});

// Preferred download path: the browser fetches bytes straight from MinIO, so large downloads cost
// the API one small JSON response instead of streaming every byte through Node.
filesRouter.get("/:id/download-url", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);
  const ttl = config.PRESIGN_TTL_SECONDS;
  res.json({
    // Pinned to the current version id, so a concurrent new upload can't change what's downloaded.
    url: await presignDownload(file.objectKey, file.originalName, file.mimeType, ttl, file.versionId ?? undefined),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  });
});

filesRouter.get("/:id/download", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);

  let object;
  try {
    object = await getObject(file.objectKey, file.versionId ?? undefined);
  } catch (err) {
    if ((err as Error).name === "NoSuchKey") {
      // A row with no object behind it: a data-consistency bug on OUR side, so 500, not 404.
      logger.error(`Dangling row: file ${file.id} has no object ${file.objectKey}`);
      throw new HttpError(500, "File content is missing");
    }
    throw err;
  }

  res.setHeader("Content-Type", file.mimeType);
  if (object.contentLength !== undefined) res.setHeader("Content-Length", object.contentLength);
  // attachment = "save as", not render in the browser. filename* (RFC 5987) handles non-ASCII names.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
  );

  // Stream MinIO → client chunk by chunk. pipeline() also cleans up both sides if the client
  // disconnects mid-download.
  await pipeline(object.body, res);
});

// ---------- Versions (Phase 6) ----------

const versionParam = z.object({ versionId: z.string().min(1).max(1024) });

function versionData(v: { versionId: string | null; size: number | bigint; etag: string; mimeType: string }) {
  return { versionId: v.versionId ?? "null", size: BigInt(v.size), etag: v.etag, mimeType: v.mimeType };
}

function toVersionDto(v: FileVersion, current: File) {
  return {
    versionId: v.versionId,
    size: Number(v.size),
    mimeType: v.mimeType,
    etag: v.etag,
    createdAt: v.createdAt,
    isCurrent: v.versionId === (current.versionId ?? "null"),
  };
}

async function findVersion(file: File, params: unknown): Promise<FileVersion> {
  const parsed = versionParam.safeParse(params);
  const version = parsed.success
    ? await prisma.fileVersion.findUnique({
        where: { fileId_versionId: { fileId: file.id, versionId: parsed.data.versionId } },
      })
    : null;
  if (!version) throw new HttpError(404, "Version not found");
  return version;
}

/**
 * Record `v` as the file's new current version, then trim history to MAX_VERSIONS.
 * If the database write fails, the S3 version we just created is deleted so nothing is orphaned.
 */
async function makeCurrent(file: File, v: Parameters<typeof versionData>[0]) {
  const data = versionData(v);
  let updated: File;
  try {
    [, updated] = await prisma.$transaction([
      prisma.fileVersion.create({ data: { ...data, fileId: file.id } }),
      prisma.file.update({
        where: { id: file.id },
        data: { size: data.size, etag: data.etag, mimeType: data.mimeType, versionId: v.versionId },
      }),
    ]);
  } catch (err) {
    await deleteObject(file.objectKey, v.versionId ?? undefined).catch(() => {});
    throw err;
  }

  await trimHistory(file);
  return updated;
}

filesRouter.get("/:id/versions", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);
  const versions = await prisma.fileVersion.findMany({
    where: { fileId: file.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(versions.map((v) => toVersionDto(v, file)));
});

// Upload new content for an existing file. The name stays; the bytes become a new S3 version.
filesRouter.post("/:id/versions", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);
  const { limit, tooLarge } = await uploadLimit(req.userId!);
  const up = await receiveUpload(req, file.objectKey, limit, tooLarge);
  res.status(201).json(toDto(await makeCurrent(file, up)));
});

// Restore = copy the old version on top of the key. History is never rewritten, only appended to.
filesRouter.post("/:id/versions/:versionId/restore", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);
  const version = await findVersion(file, req.params);
  if (version.versionId === file.versionId) throw new HttpError(409, "That is already the current version");
  const { limit } = await uploadLimit(req.userId!);
  if (Number(version.size) > limit) throw new HttpError(403, "Storage quota exceeded");

  const copy = await copyVersion(file.objectKey, version.versionId);
  const updated = await makeCurrent(file, { ...copy, size: version.size, mimeType: version.mimeType });
  res.json(toDto(updated));
});

filesRouter.get("/:id/versions/:versionId/download-url", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);
  const version = await findVersion(file, req.params);
  const ttl = config.PRESIGN_TTL_SECONDS;
  res.json({
    url: await presignDownload(file.objectKey, file.originalName, version.mimeType, ttl, version.versionId),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  });
});

// Delete one old version to free space. The current version can't be deleted this way.
filesRouter.delete("/:id/versions/:versionId", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);
  const version = await findVersion(file, req.params);
  if (version.versionId === file.versionId) {
    throw new HttpError(409, "Can't delete the current version; delete the file instead");
  }
  await prisma.fileVersion.delete({ where: { id: version.id } });
  await deleteObject(file.objectKey, version.versionId).catch((e) =>
    logger.error({ err: e }, `Orphaned version ${file.objectKey}@${version.versionId}`),
  );
  res.status(204).end();
});
