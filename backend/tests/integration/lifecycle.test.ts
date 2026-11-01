import { ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db";
import { pruneVersions, purgeExpiredTrash, reconcile } from "../../src/lifecycle";
import { bucket, deleteObject, s3 } from "../../src/storage";
import { registerAndLogin, resetState } from "../helpers";

const app = createApp();
let alice: string;
let bob: string;
const DAY = 86_400_000;

beforeEach(async () => {
  await resetState();
  alice = await registerAndLogin(app, "alice@x.io");
  bob = await registerAndLogin(app, "bob@x.io");
});
afterAll(async () => {
  await resetState();
  await prisma.$disconnect();
  s3.destroy();
});

const as = (t: string) => ({ Authorization: `Bearer ${t}` });
async function create(content = "hello", token = alice) {
  const res = await request(app).post("/files/upload").set(as(token)).attach("file", Buffer.from(content), "f.txt").expect(201);
  return res.body.id as string;
}
async function versionsInMinio(key: string) {
  const res = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
  return res.Versions?.length ?? 0;
}
const keyOf = async (id: string) => (await prisma.file.findUniqueOrThrow({ where: { id } })).objectKey;

describe("trash (Phase 7)", () => {
  it("moves a deleted file to the trash, where it can be restored", async () => {
    const id = await create();
    await request(app).delete(`/files/${id}`).set(as(alice)).expect(204);

    expect((await request(app).get("/files").set(as(alice))).body).toEqual([]);
    const trash = await request(app).get("/files/trash").set(as(alice)).expect(200);
    expect(trash.body).toHaveLength(1);
    expect(new Date(trash.body[0].purgeAt).getTime() - new Date(trash.body[0].deletedAt).getTime()).toBe(30 * DAY);

    // Trashed files are frozen: no downloads or new versions.
    await request(app).get(`/files/${id}/download-url`).set(as(alice)).expect(404);

    await request(app).post(`/files/trash/${id}/restore`).set(as(alice)).expect(200);
    expect((await request(app).get("/files").set(as(alice))).body).toHaveLength(1);
  });

  it("still counts trashed files against the quota (the bytes still exist)", async () => {
    const id = await create("12345");
    await request(app).delete(`/files/${id}`).set(as(alice)).expect(204);
    const usage = await request(app).get("/files/usage").set(as(alice)).expect(200);
    expect(usage.body).toMatchObject({ usedBytes: 5, fileCount: 0 });
  });

  it("empties the trash permanently, only for the caller", async () => {
    const mine = await create();
    const bobs = await create("bob", bob);
    await request(app).delete(`/files/${mine}`).set(as(alice)).expect(204);
    await request(app).delete(`/files/${bobs}`).set(as(bob)).expect(204);
    const key = await keyOf(mine);

    await request(app).delete("/files/trash").set(as(alice)).expect(204);
    expect(await versionsInMinio(key)).toBe(0);
    expect((await request(app).get("/files/trash").set(as(bob))).body).toHaveLength(1); // Bob's untouched
  });

  it("hides Alice's trash from Bob", async () => {
    const id = await create();
    await request(app).delete(`/files/${id}`).set(as(alice)).expect(204);
    await request(app).post(`/files/trash/${id}/restore`).set(as(bob)).expect(404);
    await request(app).delete(`/files/trash/${id}`).set(as(bob)).expect(404);
  });

  it("can't purge a file that isn't in the trash", async () => {
    const id = await create();
    await request(app).delete(`/files/trash/${id}`).set(as(alice)).expect(404);
  });
});

describe("lifecycle job (Phase 7)", () => {
  it("purges trash older than the retention period, and nothing newer", async () => {
    const old = await create("old");
    const recent = await create("recent");
    await prisma.file.update({ where: { id: old }, data: { deletedAt: new Date(Date.now() - 31 * DAY) } });
    await prisma.file.update({ where: { id: recent }, data: { deletedAt: new Date(Date.now() - 1 * DAY) } });
    const oldKey = await keyOf(old);

    expect(await purgeExpiredTrash()).toBe(1);
    expect(await prisma.file.findUnique({ where: { id: old } })).toBeNull();
    expect(await versionsInMinio(oldKey)).toBe(0);
    expect(await prisma.file.findUnique({ where: { id: recent } })).not.toBeNull();
  });

  it("prunes history when MAX_VERSIONS is lowered after the fact", async () => {
    const id = await create("v1");
    for (const c of ["v2", "v3"]) {
      await request(app).post(`/files/${id}/versions`).set(as(alice)).attach("file", Buffer.from(c), "f.txt").expect(201);
    }
    expect(await pruneVersions(1)).toBe(2);
    expect(await prisma.fileVersion.count({ where: { fileId: id } })).toBe(1);
    expect(await versionsInMinio(await keyOf(id))).toBe(1);
  });

  it("deletes orphan bytes (no row) once past the grace period; dry-run only reports", async () => {
    await create(); // a normal file must survive
    const orphanKey = "users/00000000-0000-0000-0000-000000000000/orphan";
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: orphanKey, Body: "leftover" }));

    expect(await reconcile()).toEqual({ orphans: 0, dangling: 0 }); // too new: may be an in-flight upload
    expect(await reconcile({ dryRun: true, graceMs: 0 })).toEqual({ orphans: 1, dangling: 0 });
    expect(await versionsInMinio(orphanKey)).toBe(1);

    expect(await reconcile({ graceMs: 0 })).toEqual({ orphans: 1, dangling: 0 });
    expect(await versionsInMinio(orphanKey)).toBe(0);
    expect(await reconcile({ graceMs: 0 })).toEqual({ orphans: 0, dangling: 0 });
  });

  it("reports (never deletes) rows whose bytes are missing", async () => {
    const id = await create();
    const file = await prisma.file.findUniqueOrThrow({ where: { id } });
    await deleteObject(file.objectKey, file.versionId!); // simulate data loss behind our back
    const silence = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(await reconcile({ graceMs: 0 })).toEqual({ orphans: 0, dangling: 1 });
    expect(await prisma.file.findUnique({ where: { id } })).not.toBeNull(); // kept for a human to look at
    silence.mockRestore();
  });
});
