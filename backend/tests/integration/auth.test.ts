import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db";
import { resetState } from "../helpers";

const app = createApp();

beforeEach(resetState);
afterAll(() => prisma.$disconnect());

describe("POST /auth/register", () => {
  it("creates a user and normalises the email", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: "  Alice@Example.COM ", password: "password-123" })
      .expect(201);
    expect(res.body).toEqual({ id: expect.any(String), email: "alice@example.com" });
  });

  it("stores a hash, not the password", async () => {
    await request(app).post("/auth/register").send({ email: "a@x.io", password: "password-123" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "a@x.io" } });
    expect(user.passwordHash).not.toContain("password-123");
  });

  it("rejects a duplicate email with 409", async () => {
    const body = { email: "a@x.io", password: "password-123" };
    await request(app).post("/auth/register").send(body).expect(201);
    await request(app).post("/auth/register").send(body).expect(409);
  });

  it.each([
    [{ email: "not-an-email", password: "password-123" }],
    [{ email: "a@x.io", password: "short" }],
    [{ email: "a@x.io" }],
  ])("rejects invalid input %j with 400", async (body) => {
    await request(app).post("/auth/register").send(body).expect(400);
  });

  it("rejects malformed JSON with 400", async () => {
    await request(app)
      .post("/auth/register")
      .set("Content-Type", "application/json")
      .send("{not json")
      .expect(400);
  });
});

describe("POST /auth/login", () => {
  beforeEach(async () => {
    await request(app).post("/auth/register").send({ email: "a@x.io", password: "password-123" });
  });

  it("returns a JWT for correct credentials", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "A@x.io", password: "password-123" })
      .expect(200);
    expect(res.body.token.split(".")).toHaveLength(3); // header.payload.signature
  });

  it("gives the same 401 for a wrong password and an unknown email", async () => {
    const wrong = await request(app).post("/auth/login").send({ email: "a@x.io", password: "nope-nope-nope" });
    const unknown = await request(app).post("/auth/login").send({ email: "b@x.io", password: "password-123" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });
});

describe("protected routes", () => {
  it.each([
    ["no header", undefined],
    ["wrong scheme", "Basic abc"],
    ["garbage token", "Bearer not.a.jwt"],
    ["token signed with another secret", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl"],
  ])("rejects %s with 401", async (_label, header) => {
    const req = request(app).get("/files");
    if (header) req.set("Authorization", header);
    await req.expect(401);
  });
});
