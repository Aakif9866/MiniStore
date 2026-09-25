import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../auth";
import { config } from "../config";
import { prisma } from "../db";
import { HttpError } from "../errors";
import type { File } from "../generated/prisma/client";
import { bucket, deleteObject, getObject, putObject } from "../storage";

export const filesRouter = Router();
filesRouter.use(requireAuth);

// DELIBERATE SIMPLIFICATION: memoryStorage holds the whole upload in RAM before we send it to
// MinIO. Fine for small files; Phase 5 measures why this breaks for large ones and replaces it
// with streaming.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
  // Browsers and curl send filenames as raw UTF-8; multer's default (latin1) turns "é" into "Ã©".
  defParamCharset: "utf8",
});

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

filesRouter.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Send the file as multipart/form-data field "file"');
  const userId = req.userId!;

  // We choose the key. The user's filename is only stored as metadata, so it can never
  // cause path traversal or overwrite someone else's object.
  const objectKey = `users/${userId}/${randomUUID()}`;
  const mimeType = req.file.mimetype || "application/octet-stream";

  // Step 1: bytes → MinIO.
  const { etag, versionId } = await putObject(objectKey, req.file.buffer, mimeType);

  // Step 2: metadata → Postgres. If this fails, the object from step 1 is an orphan:
  // try to remove it, and if even that fails it stays orphaned (harmless, cleanable later).
  try {
    const file = await prisma.file.create({
      data: {
        userId,
        originalName: req.file.originalname,
        objectKey,
        bucket,
        mimeType,
        size: BigInt(req.file.size),
        etag,
        versionId,
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
