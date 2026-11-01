import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db";
import { bucket, s3 } from "../../src/storage";
import { binaryParser, registerAndLogin, resetState } from "../helpers";

const app = createApp();
let alice: string;
let bob: string;

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

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function create(content: string) {
  const res = await request(app).post("/files/upload").set(as(alice)).attach("file", Buffer.from(content), "doc.txt").expect(201);
  return res.body as { id: string; versionId: string };
}
const newVersion = (id: string, content: string | Buffer, name = "doc.txt", token = alice) =>
  request(app).post(`/files/${id}/versions`).set(as(token)).attach("file", Buffer.from(content), name);

const versions = async (id: string) =>
  (await request(app).get(`/files/${id}/versions`).set(as(alice)).expect(200)).body as {
    versionId: string;
    isCurrent: boolean;
    size: number;
  }[];

async function currentContent(id: string) {
  const res = await request(app).get(`/files/${id}/download`).set(as(alice)).buffer(true).parse(binaryParser).expect(200);
  return res.body.toString();
}

async function s3Versions(fileId: string) {
  const { objectKey } = await prisma.file.findUniqueOrThrow({ where: { id: fileId } });
  return listS3(objectKey);
}
async function listS3(key: string) {
  const res = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
  return { versions: res.Versions?.length ?? 0, markers: res.DeleteMarkers?.length ?? 0 };
}

describe("versioning (Phase 6)", () => {
  it("keeps every upload as a version; the newest is current", async () => {
    const { id, versionId: v1 } = await create("version one");
    await newVersion(id, "version two").expect(201);

    const list = await versions(id);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ isCurrent: true, size: 11 });
    expect(list[1]).toMatchObject({ versionId: v1, isCurrent: false });
    expect(await currentContent(id)).toBe("version two");

    // An old version is still downloadable through its own presigned URL.
    const { body } = await request(app).get(`/files/${id}/versions/${v1}/download-url`).set(as(alice)).expect(200);
    expect(await (await fetch(body.url)).text()).toBe("version one");
  });

  it("restores an old version by appending a copy (history is never rewritten)", async () => {
    const { id, versionId: v1 } = await create("original");
    await newVersion(id, "oops, overwritten").expect(201);

    const restored = await request(app).post(`/files/${id}/versions/${v1}/restore`).set(as(alice)).expect(200);
    expect(restored.body.versionId).not.toBe(v1); // a NEW version with the old bytes
    expect(await currentContent(id)).toBe("original");
    expect(await versions(id)).toHaveLength(3);
  });

  it("refuses to restore the version that is already current", async () => {
    const { id, versionId } = await create("only");
    await request(app).post(`/files/${id}/versions/${versionId}/restore`).set(as(alice)).expect(409);
  });

  it("keeps at most MAX_VERSIONS (3 in tests), in Postgres and in MinIO", async () => {
    const { id } = await create("v1");
    for (const c of ["v2", "v3", "v4", "v5"]) await newVersion(id, c).expect(201);
    expect(await versions(id)).toHaveLength(3);
    expect((await s3Versions(id)).versions).toBe(3);
    expect(await currentContent(id)).toBe("v5");
  });

  it("deletes an old version, but never the current one", async () => {
    const { id, versionId: v1 } = await create("old");
    const v2 = (await newVersion(id, "new").expect(201)).body.versionId;

    await request(app).delete(`/files/${id}/versions/${v2}`).set(as(alice)).expect(409);
    await request(app).delete(`/files/${id}/versions/${v1}`).set(as(alice)).expect(204);
    expect(await versions(id)).toHaveLength(1);
    expect((await s3Versions(id)).versions).toBe(1);
  });

  it("deleting a file removes every version AND leaves no delete marker", async () => {
    const { id } = await create("a");
    await newVersion(id, "b").expect(201);
    const { objectKey } = await prisma.file.findUniqueOrThrow({ where: { id } });

    await request(app).delete(`/files/${id}`).set(as(alice)).expect(204); // to trash
    await request(app).delete(`/files/trash/${id}`).set(as(alice)).expect(204); // permanently
    expect(await listS3(objectKey)).toEqual({ versions: 0, markers: 0 });
    expect(await prisma.fileVersion.count()).toBe(0);
  });

  it("counts every version against the quota", async () => {
    const { id } = await create("x".repeat(1000));
    await newVersion(id, "y".repeat(1000)).expect(201);
    const usage = await request(app).get("/files/usage").set(as(alice)).expect(200);
    expect(usage.body.usedBytes).toBe(2000);
  });

  it("applies upload checks to new versions too: an executable is rejected and nothing changes", async () => {
    const { id } = await create("safe");
    await newVersion(id, Buffer.from("MZ\x90\x00", "latin1"), "update.txt").expect(415);
    expect(await versions(id)).toHaveLength(1);
    expect(await currentContent(id)).toBe("safe");
  });

  it("hides Alice's versions from Bob on every route (404)", async () => {
    const { id, versionId } = await create("private");
    await request(app).get(`/files/${id}/versions`).set(as(bob)).expect(404);
    await newVersion(id, "bob was here", "x.txt", bob).expect(404);
    await request(app).post(`/files/${id}/versions/${versionId}/restore`).set(as(bob)).expect(404);
    await request(app).get(`/files/${id}/versions/${versionId}/download-url`).set(as(bob)).expect(404);
    await request(app).delete(`/files/${id}/versions/${versionId}`).set(as(bob)).expect(404);
    expect(await currentContent(id)).toBe("private");
  });

  it("returns 404 for an unknown version id", async () => {
    const { id } = await create("a");
    await request(app).get(`/files/${id}/versions/not-a-version/download-url`).set(as(alice)).expect(404);
  });
});
