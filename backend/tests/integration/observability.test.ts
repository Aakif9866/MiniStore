import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db";
import { createMetricsApp } from "../../src/observability";
import { s3 } from "../../src/storage";
import { registerAndLogin, resetState } from "../helpers";

const app = createApp();
const metrics = createMetricsApp();
let token: string;

beforeAll(async () => {
  await resetState();
  token = await registerAndLogin(app, "obs@x.io");
});
afterAll(async () => {
  await resetState();
  await prisma.$disconnect();
  s3.destroy();
});

const scrape = async () => (await request(metrics).get("/metrics").expect(200)).text;

describe("request ids", () => {
  it("generates one per request and returns it", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a sane incoming id (to correlate across services) and replaces an unsafe one", async () => {
    expect((await request(app).get("/health").set("X-Request-Id", "abc-123")).headers["x-request-id"]).toBe("abc-123");
    // Spaces/quotes (log forging) and huge values (log bloat) are replaced, not echoed.
    for (const evil of ['x" admin="true', "a".repeat(500)]) {
      const res = await request(app).get("/health").set("X-Request-Id", evil);
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("metrics (Phase 8)", () => {
  it("labels requests by route pattern, never by raw id (bounded cardinality)", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    await request(app).get(`/files/${id}`).set("Authorization", `Bearer ${token}`).expect(404);
    await request(app).get("/files").expect(401); // rejected before any route matched

    const text = await scrape();
    expect(text).toMatch(/http_request_duration_seconds_count\{method="GET",route="\/files\/:id",status_code="404"\} \d+/);
    expect(text).toMatch(/http_request_duration_seconds_count\{method="GET",route="\/files\/\*",status_code="401"\} \d+/);
    expect(text).not.toContain(id);
  });

  it("times S3 calls by operation and counts uploaded bytes", async () => {
    const before = Number((await scrape()).match(/^ministore_uploaded_bytes_total (\d+)/m)?.[1] ?? 0);
    await request(app).post("/files/upload").set("Authorization", `Bearer ${token}`).attach("file", Buffer.from("12345"), "m.txt").expect(201);

    const text = await scrape();
    expect(text).toMatch(/ministore_s3_request_duration_seconds_count\{operation="PutObjectCommand",outcome="ok"\} \d+/);
    expect(Number(text.match(/^ministore_uploaded_bytes_total (\d+)/m)?.[1])).toBe(before + 5);
    expect(text).toContain("nodejs_eventloop_lag_seconds"); // default process metrics are on
  });
});

describe("readiness vs liveness", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is ready when Postgres and MinIO both answer", async () => {
    const res = await request(app).get("/ready").expect(200);
    expect(res.body).toEqual({ status: "ready", postgres: "ok", minio: "ok" });
  });

  it("is NOT ready (503) when MinIO is down, while /health still says the process is alive", async () => {
    jest.spyOn(s3, "send").mockRejectedValue(new Error("ECONNREFUSED") as never);
    const res = await request(app).get("/ready").expect(503);
    expect(res.body).toMatchObject({ postgres: "ok", minio: "down" });
    await request(app).get("/health").expect(200);
  });

  it("is NOT ready (503) when Postgres is down", async () => {
    jest.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("P1001") as never);
    const res = await request(app).get("/ready").expect(503);
    expect(res.body).toMatchObject({ postgres: "down", minio: "ok" });
  });
});
