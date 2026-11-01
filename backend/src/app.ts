import { HeadBucketCommand } from "@aws-sdk/client-s3";
import express from "express";
import { prisma } from "./db";
import { errorHandler } from "./errors";
import { authRouter } from "./routes/auth.routes";
import { filesRouter } from "./routes/files.routes";
import { requestObserver } from "./observability";
import { securityHeaders } from "./security";
import { bucket, s3 } from "./storage";

// Builds the app without listening, so tests can drive it in-process with Supertest.
export function createApp() {
  const app = express();
  app.disable("x-powered-by"); // don't advertise the framework
  app.use(requestObserver);
  app.use(securityHeaders);

  app.use(express.json({ limit: "10kb" })); // JSON bodies are tiny; files go via multipart

  // Liveness: is the process up? (A restart might help if not.)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: can this instance do its job right now? A load balancer should stop sending traffic
  // while this is 503 — restarting won't fix a database outage.
  app.get("/ready", async (_req, res) => {
    const check = (p: Promise<unknown>) =>
      Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000))]).then(
        () => "ok",
        () => "down",
      );
    const [postgres, minio] = await Promise.all([
      check(prisma.$queryRaw`SELECT 1`),
      check(s3.send(new HeadBucketCommand({ Bucket: bucket }))),
    ]);
    const ready = postgres === "ok" && minio === "ok";
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not ready", postgres, minio });
  });

  for (const [base, router] of [["/auth", authRouter], ["/files", filesRouter]] as const) {
    app.use(base, (_req, res, next) => ((res.locals.routeBase = base), next()), router);
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler); // Express 5 forwards rejected async handlers here automatically
  return app;
}
