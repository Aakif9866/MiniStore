import { randomBytes } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
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

function upload(token: string, content: Buffer | string, filename = "notes.txt") {
  return request(app)
    .post("/files/upload")
    .set("Authorization", `Bearer ${token}`)
    .attach("file", Buffer.from(content), filename);
}

async function objectExists(key: string) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if ((err as Error).name === "NotFound") return false;
    throw err;
  }
}

describe("upload → list → get → download → delete", () => {
  it("round-trips the exact bytes and keeps Postgres and MinIO in step", async () => {
    const content = randomBytes(256 * 1024);
    const up = await upload(alice, content, "photo.jpg").expect(201);
    expect(up.body).toMatchObject({ name: "photo.jpg", size: content.length, versionId: null });
    expect(up.body).not.toHaveProperty("objectKey"); // internal detail stays internal

    // Metadata is in Postgres and the bytes are in MinIO under a key we generated.
    const row = await prisma.file.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(row.objectKey).toMatch(/^users\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    expect(await objectExists(row.objectKey)).toBe(true);

    const list = await request(app).get("/files").set("Authorization", `Bearer ${alice}`).expect(200);
    expect(list.body.map((f: { id: string }) => f.id)).toEqual([up.body.id]);

    await request(app).get(`/files/${up.body.id}`).set("Authorization", `Bearer ${alice}`).expect(200);

    const dl = await request(app)
      .get(`/files/${up.body.id}/download`)
      .set("Authorization", `Bearer ${alice}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(Buffer.compare(dl.body, content)).toBe(0);
    expect(dl.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''photo.jpg");

    await request(app).delete(`/files/${up.body.id}`).set("Authorization", `Bearer ${alice}`).expect(204);
    await request(app).get(`/files/${up.body.id}`).set("Authorization", `Bearer ${alice}`).expect(404);
    expect(await objectExists(row.objectKey)).toBe(false);
  });

  it("keeps non-ASCII filenames intact", async () => {
    const res = await upload(alice, "hi", "résumé 日本.txt").expect(201);
    expect(res.body.name).toBe("résumé 日本.txt");
  });

  it("stores a path-like filename as plain metadata, never as the key", async () => {
    const res = await upload(alice, "x", "../../etc/passwd").expect(201);
    const row = await prisma.file.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.objectKey).not.toContain("..");
  });
});

describe("authorization: users only see their own files", () => {
  it("returns 404 (not 403) for someone else's file on every route", async () => {
    const { body } = await upload(alice, "alice's secret").expect(201);
    const auth = { Authorization: `Bearer ${bob}` };

    await request(app).get(`/files/${body.id}`).set(auth).expect(404);
    await request(app).get(`/files/${body.id}/download`).set(auth).expect(404);
    await request(app).delete(`/files/${body.id}`).set(auth).expect(404);
    const list = await request(app).get("/files").set(auth).expect(200);
    expect(list.body).toEqual([]);

    // Bob's failed delete must not have touched Alice's file.
    await request(app).get(`/files/${body.id}`).set("Authorization", `Bearer ${alice}`).expect(200);
  });
});

describe("upload validation", () => {
  it("rejects a request without a file with 400", async () => {
    await request(app).post("/files/upload").set("Authorization", `Bearer ${alice}`).expect(400);
  });

  it("rejects a file over MAX_UPLOAD_BYTES with 413 and stores nothing", async () => {
    await upload(alice, Buffer.alloc(1024 * 1024 + 1)).expect(413);
    expect(await prisma.file.count()).toBe(0);
  });

  it("returns 404 for a malformed id instead of a database error", async () => {
    await request(app).get("/files/not-a-uuid").set("Authorization", `Bearer ${alice}`).expect(404);
  });
});

describe("consistency between MinIO and Postgres", () => {
  it("removes the uploaded object when the metadata insert fails (no orphan)", async () => {
    const spy = jest.spyOn(prisma.file, "create").mockRejectedValueOnce(new Error("db down"));
    const silence = jest.spyOn(console, "error").mockImplementation(() => {});

    await upload(alice, "doomed").expect(500);

    // Recover the key we tried to insert and confirm the object was cleaned up.
    const attempted = spy.mock.calls[0][0].data.objectKey as string;
    expect(await objectExists(attempted)).toBe(false);
    spy.mockRestore();
    silence.mockRestore();
  });
});
