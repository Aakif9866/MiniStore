import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { config } from "./config";
import { prisma } from "./db";
import { purgeFile, trimHistory } from "./file-service";
import { bucket, deleteObject, s3 } from "./storage";

const DAY = 24 * 60 * 60 * 1000;

/** Permanently delete files that have been in the trash longer than the retention period. */
export async function purgeExpiredTrash(now = new Date(), retentionDays = config.TRASH_RETENTION_DAYS) {
  const expired = await prisma.file.findMany({
    where: { deletedAt: { lt: new Date(now.getTime() - retentionDays * DAY) } },
    select: { id: true, objectKey: true },
  });
  for (const f of expired) await purgeFile(f);
  return expired.length;
}

/** Enforce MAX_VERSIONS on files written before the limit was lowered. */
export async function pruneVersions(keep = config.MAX_VERSIONS) {
  const files = await prisma.file.findMany({
    where: { versions: { some: {} } },
    select: { id: true, objectKey: true, _count: { select: { versions: true } } },
  });
  let removed = 0;
  for (const f of files) if (f._count.versions > keep) removed += await trimHistory(f, keep);
  return removed;
}

/**
 * Compare MinIO with Postgres.
 * - Orphans (bytes with no row): deleted, once older than `graceMs` — younger ones may be uploads
 *   whose row is about to be written.
 * - Dangling rows (row with no bytes): only reported. That's data loss; a human must look.
 * ponytail: loads every version id into memory and lists the whole prefix. Fine for millions of
 * objects; beyond that, use S3 Inventory reports instead of listing.
 */
export async function reconcile({ dryRun = false, graceMs = config.ORPHAN_GRACE_MINUTES * 60_000, now = new Date() } = {}) {
  const rows = await prisma.fileVersion.findMany({ select: { versionId: true, file: { select: { objectKey: true } } } });
  const known = new Set(rows.map((r) => `${r.file.objectKey}@${r.versionId}`));

  const orphans: { key: string; versionId: string }[] = [];
  const seen = new Set<string>();
  let KeyMarker: string | undefined;
  let VersionIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: "users/", KeyMarker, VersionIdMarker }),
    );
    for (const v of page.Versions ?? []) {
      const id = `${v.Key}@${v.VersionId}`;
      seen.add(id);
      if (!known.has(id) && now.getTime() - v.LastModified!.getTime() > graceMs) {
        orphans.push({ key: v.Key!, versionId: v.VersionId! });
      }
    }
    ({ NextKeyMarker: KeyMarker, NextVersionIdMarker: VersionIdMarker } = page);
    if (!page.IsTruncated) break;
  } while (true);

  if (!dryRun) for (const o of orphans) await deleteObject(o.key, o.versionId);
  const dangling = [...known].filter((id) => !seen.has(id));
  for (const d of dangling) console.error(`Dangling row: no bytes in MinIO for ${d}`);
  return { orphans: orphans.length, dangling: dangling.length };
}

/** One pass of every lifecycle task. Each is independent, so one failing doesn't stop the rest. */
export async function runLifecycle({ dryRun = false } = {}) {
  const summary: Record<string, unknown> = {};
  const tasks: [string, () => Promise<unknown>][] = [
    ["trashPurged", () => (dryRun ? Promise.resolve("skipped (dry run)") : purgeExpiredTrash())],
    ["versionsPruned", () => (dryRun ? Promise.resolve("skipped (dry run)") : pruneVersions())],
    ["reconcile", () => reconcile({ dryRun })],
  ];
  for (const [name, task] of tasks) {
    summary[name] = await task().catch((err) => {
      console.error(`Lifecycle task ${name} failed`, err);
      return "failed";
    });
  }
  return summary;
}
