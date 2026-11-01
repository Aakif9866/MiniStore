import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db";
import { presignDownload, s3 } from "../../src/storage";
import { registerAndLogin, resetState } from "../helpers";

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

async function uploadAs(token: string, content: string, filename: string) {
  const res = await request(app)
    .post("/files/upload")
    .set("Authorization", `Bearer ${token}`)
    .attach("file", Buffer.from(content), filename)
    .expect(201);
  return res.body as { id: string };
}

const getUrl = (token: string, id: string) =>
  request(app).get(`/files/${id}/download-url`).set("Authorization", `Bearer ${token}`);

describe("presigned download URLs (Phase 4)", () => {
  it("lets anyone holding the URL download the exact bytes from MinIO, as an attachment", async () => {
    const { id } = await uploadAs(alice, "hello from minio", "résumé.txt");
    const { body } = await getUrl(alice, id).expect(200);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const res = await fetch(body.url); // no Authorization header: the signature is the credential
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from minio");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt");
  });

  it("returns 404 for someone else's file, so Bob can't mint a URL for Alice's", async () => {
    const { id } = await uploadAs(alice, "secret", "a.txt");
    await getUrl(bob, id).expect(404);
  });

  it("rejects a tampered URL (signature covers the key and the response headers)", async () => {
    const { id } = await uploadAs(alice, "secret", "a.txt");
    const { body } = await getUrl(alice, id).expect(200);

    const otherKey = body.url.replace(/users%2F|users\//, "users/0"); // point at a different object
    expect((await fetch(otherKey)).status).toBe(403);

    const inline = body.url.replace(/attachment/, "inline"); // try to make the browser render it
    expect((await fetch(inline)).status).toBe(403);
  });

  it("stops working after it expires", async () => {
    const { id } = await uploadAs(alice, "short-lived", "a.txt");
    const row = await prisma.file.findUniqueOrThrow({ where: { id } });
    const url = await presignDownload(row.objectKey, row.originalName, row.mimeType, 1);
    expect((await fetch(url)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2100));
    expect((await fetch(url)).status).toBe(403);
  });
});
