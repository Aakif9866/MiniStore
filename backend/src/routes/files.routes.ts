import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { config } from "../config";
import { prisma } from "../db";
import { HttpError } from "../errors";
import type { File } from "../generated/prisma/client";
import { bucket, deleteObject, getObject, presignDownload } from "../storage";
import { receiveUpload } from "../upload-stream";

export const filesRouter = Router();
filesRouter.use(requireAuth);

const idParam = z.object({ id: z.uuid() });

/** Find a file only if it belongs to the caller. Not-yours and doesn't-exist both give 404. */
async function findOwnedFile(userId: string, params: unknown): Promise<File> {
  const parsed = idParam.safeParse(params);
  const file = parsed.success
    ? await prisma.file.findFirst({ where: { id: parsed.data.id, userId } })
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

filesRouter.post("/upload", async (req, res) => {
  const userId = req.userId!;

  // The quota is enforced WHILE streaming: the limit for this upload is whatever is left.
  // ponytail: two concurrent uploads each see the same "left" and can overshoot by one file.
  // A per-user lock (or SELECT … FOR UPDATE) closes it if exact quotas ever matter.
  const left = config.MAX_USER_STORAGE_BYTES - (await usedBytes(userId));
  if (left <= 0) throw new HttpError(403, "Storage quota exceeded");
  const overQuota = left < config.MAX_UPLOAD_BYTES;
  const tooLarge = overQuota
    ? new HttpError(403, "Storage quota exceeded")
    : new HttpError(413, "File too large");

  // We choose the key. The user's filename is only stored as metadata, so it can never
  // cause path traversal or overwrite someone else's object.
  const objectKey = `users/${userId}/${randomUUID()}`;

  // Step 1: bytes → MinIO, streamed in parts (never the whole file in memory).
  const up = await receiveUpload(req, objectKey, Math.min(left, config.MAX_UPLOAD_BYTES), tooLarge);

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
      },
    });
    res.status(201).json(toDto(file));
  } catch (err) {
    await deleteObject(objectKey).catch((e) =>
      console.error(`Orphaned object ${objectKey}: cleanup failed`, e),
    );
    throw err;
  }
});

async function usedBytes(userId: string): Promise<number> {
  const { _sum } = await prisma.file.aggregate({ where: { userId }, _sum: { size: true } });
  return Number(_sum.size ?? 0);
}

// Registered before "/:id" so "usage" isn't treated as a file id.
filesRouter.get("/usage", async (req, res) => {
  const userId = req.userId!;
  res.json({
    usedBytes: await usedBytes(userId),
    quotaBytes: config.MAX_USER_STORAGE_BYTES,
    fileCount: await prisma.file.count({ where: { userId } }),
  });
});

filesRouter.get("/", async (req, res) => {
  const files = await prisma.file.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
    take: 100, // pagination comes later; never return an unbounded list
  });
  res.json(files.map(toDto));
});

filesRouter.get("/:id", async (req, res) => {
  res.json(toDto(await findOwnedFile(req.userId!, req.params)));
});

filesRouter.delete("/:id", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);

  // Row first, then object. If the object delete fails, we're left with an orphan object
  // (invisible to users). The reverse order could leave a row pointing at nothing.
  await prisma.file.delete({ where: { id: file.id } });
  await deleteObject(file.objectKey).catch((e) =>
    console.error(`Orphaned object ${file.objectKey}: delete failed`, e),
  );
  res.status(204).end();
});

// Preferred download path: the browser fetches bytes straight from MinIO, so large downloads cost
// the API one small JSON response instead of streaming every byte through Node.
filesRouter.get("/:id/download-url", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);
  const ttl = config.PRESIGN_TTL_SECONDS;
  res.json({
    url: await presignDownload(file.objectKey, file.originalName, file.mimeType, ttl),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  });
});

filesRouter.get("/:id/download", async (req, res) => {
  const file = await findOwnedFile(req.userId!, req.params);

  let object;
  try {
    object = await getObject(file.objectKey);
  } catch (err) {
    if ((err as Error).name === "NoSuchKey") {
      // A row with no object behind it: a data-consistency bug on OUR side, so 500, not 404.
      console.error(`Dangling row: file ${file.id} has no object ${file.objectKey}`);
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
