import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ListMultipartUploadsCommand } from "@aws-sdk/client-s3";
import express from "express";
import request from "supertest";
import { errorHandler, HttpError } from "../../src/errors";
import { bucket, deleteObject, getObject, s3 } from "../../src/storage";
import { receiveUpload } from "../../src/upload-stream";

// A bare app around receiveUpload, so each test can choose its own size limit.
const PREFIX = `test-stream/${Date.now()}`;
let n = 0;
let lastKey = "";
function appWithLimit(maxBytes: number) {
  const app = express();
  app.post("/up", async (req, res) => {
    lastKey = `${PREFIX}/${n++}`;
    res.status(201).json(await receiveUpload(req, lastKey, maxBytes, new HttpError(413, "File too large")));
  });
  app.use(errorHandler);
  return app;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function readObject(key: string) {
  const chunks: Buffer[] = [];
  for await (const c of (await getObject(key)).body) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
async function pendingMultipartUploads() {
  const res = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: PREFIX }));
  return res.Uploads?.length ?? 0;
}
async function eventually(check: () => Promise<boolean>, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    if (await check()) return true;
  }
  return false;
}

afterAll(() => s3.destroy());

describe("streaming uploads (Phase 5)", () => {
  it("uploads a file bigger than one part as an S3 multipart upload, byte-exact", async () => {
    const content = randomBytes(20 * 1024 * 1024); // 20 MiB → 3 parts of 8 MiB
    const res = await request(appWithLimit(50 * 1024 * 1024)).post("/up").attach("file", content, "big.bin").expect(201);
    expect(res.body.size).toBe(content.length);
    expect(res.body.etag).toMatch(/-3$/); // multipart ETags end in -<part count>
    expect(sha(await readObject(lastKey))).toBe(sha(content));
    await deleteObject(lastKey);
  });

  it("stops at the limit mid-stream: 413, no object, no leftover parts", async () => {
    const res = await request(appWithLimit(10 * 1024 * 1024))
      .post("/up")
      .attach("file", randomBytes(20 * 1024 * 1024), "too-big.bin");
    expect(res.status).toBe(413);
    await expect(getObject(lastKey)).rejects.toMatchObject({ name: "NoSuchKey" });
    expect(await eventually(async () => (await pendingMultipartUploads()) === 0)).toBe(true);
  });

  it("cleans up when the client disconnects mid-upload", async () => {
    const server = appWithLimit(100 * 1024 * 1024).listen(0);
    const { port } = server.address() as AddressInfo;
    const boundary = "xBOUNDARYx";
    const req = http.request({
      port,
      method: "POST",
      path: "/up",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": 50 * 1024 * 1024 },
    });
    req.on("error", () => {}); // we're about to kill it on purpose
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\n\r\n`);
    req.write(randomBytes(18 * 1024 * 1024)); // enough for at least one part to start uploading
    await new Promise((r) => setTimeout(r, 500));
    req.destroy(); // client goes away

    expect(await eventually(async () => (await pendingMultipartUploads()) === 0)).toBe(true);
    await expect(getObject(lastKey)).rejects.toMatchObject({ name: "NoSuchKey" });
    server.close();
  });

  it("rejects a non-multipart body with 400", async () => {
    await request(appWithLimit(1024)).post("/up").send({ file: "nope" }).expect(400);
  });
});
