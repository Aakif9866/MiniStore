// Measures the API's peak memory (RSS) while it receives one large upload.
// Usage: npx tsx scripts/measure-upload-memory.ts <megabytes>   (uses the dev DB + bucket, cleans up)
import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const mb = Number(process.argv[2] ?? 200);
process.env.MAX_UPLOAD_BYTES = String(10 * 1024 ** 3); // lift limits for the experiment
process.env.MAX_USER_STORAGE_BYTES = String(10 * 1024 ** 3);

async function main() {
  const { createApp } = await import("../src/app");
  const { prisma } = await import("../src/db");

  // Write the test file to disk first, so building it doesn't count against the server's memory.
  const file = path.join(tmpdir(), `ministore-${mb}mb.bin`);
  const out = createWriteStream(file);
  const chunk = Buffer.alloc(1024 * 1024, 7);
  for (let i = 0; i < mb; i++) if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
  await new Promise((r) => out.end(r));

  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const email = `mem-${randomUUID()}@test.dev`;
  const json = (body: object) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await fetch(`${base}/auth/register`, json({ email, password: "password-123" }));
  const { token } = await (await fetch(`${base}/auth/login`, json({ email, password: "password-123" }))).json();

  global.gc?.();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);

  const form = new FormData();
  form.append("file", await openAsBlob(file), "big.bin"); // read lazily from disk while sending
  const started = Date.now();
  const res = await fetch(`${base}/files/upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  const seconds = (Date.now() - started) / 1000;
  clearInterval(sampler);
  const body = await res.json();

  const toMb = (n: number) => (n / 1024 ** 2).toFixed(0);
  console.log(`upload ${mb} MB → HTTP ${res.status} in ${seconds.toFixed(1)} s (${(mb / seconds).toFixed(0)} MB/s)`);
  console.log(`RSS baseline ${toMb(baseline)} MB, peak ${toMb(peak)} MB, growth ${toMb(peak - baseline)} MB`);

  // Clean up: the file through the API, then the user.
  if (body.id) await fetch(`${base}/files/${body.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  await prisma.user.delete({ where: { email } });
  await rm(file);
  server.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
