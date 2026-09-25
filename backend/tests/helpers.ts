import type { Express } from "express";
import request from "supertest";
import { prisma } from "../src/db";
import { deleteObject } from "../src/storage";

/** Remove every object the test DB knows about, then empty the tables. */
export async function resetState() {
  const files = await prisma.file.findMany({ select: { objectKey: true } });
  await Promise.all(files.map((f) => deleteObject(f.objectKey)));
  await prisma.$executeRaw`TRUNCATE files, users CASCADE`;
}

export async function registerAndLogin(app: Express, email: string, password = "password-123") {
  await request(app).post("/auth/register").send({ email, password }).expect(201);
  const res = await request(app).post("/auth/login").send({ email, password }).expect(200);
  return res.body.token as string;
}

/** Supertest parser that collects the raw response body as a Buffer. */
export function binaryParser(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const stream = res as unknown as NodeJS.ReadableStream; // at runtime this is the raw HTTP stream
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  stream.on("end", () => cb(null, Buffer.concat(chunks)));
}
