import { config } from "./config";
import { prisma } from "./db";
import { logger } from "./observability";
import type { File } from "./generated/prisma/client";
import { deleteObject, purgeObject } from "./storage";

// Operations shared by the HTTP routes and the lifecycle job. All follow the same rule:
// Postgres rows first, bytes second. A failure in between leaves an orphan object (invisible,
// cleaned by reconcile) — never a row pointing at missing bytes.

/** Permanently delete a file: its rows (versions cascade), then every version in MinIO. */
export async function purgeFile(file: Pick<File, "id" | "objectKey">) {
  await prisma.file.delete({ where: { id: file.id } });
  await purgeObject(file.objectKey).catch((e) => logger.error({ err: e }, `Orphaned object ${file.objectKey}: purge failed`));
}

/** Delete the oldest versions of a file beyond `keep`. Returns how many were removed. */
export async function trimHistory(file: Pick<File, "id" | "objectKey">, keep = config.MAX_VERSIONS) {
  const excess = await prisma.fileVersion.findMany({
    where: { fileId: file.id },
    orderBy: { createdAt: "desc" },
    skip: keep,
  });
  if (!excess.length) return 0;
  await prisma.fileVersion.deleteMany({ where: { id: { in: excess.map((e) => e.id) } } });
  for (const e of excess) {
    await deleteObject(file.objectKey, e.versionId).catch((err) =>
      logger.error({ err }, `Orphaned version ${file.objectKey}@${e.versionId}`),
    );
  }
  return excess.length;
}
