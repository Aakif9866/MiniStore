import { randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import pino from "pino";
import client from "prom-client";

// ---------- Logs ----------
// One JSON object per line: easy for machines (Loki, CloudWatch, jq) to parse and filter.
// In dev, pipe through pino-pretty (see `npm run dev`).
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["req.headers.authorization", "req.headers.cookie"], // never log credentials
});

// ---------- Metrics ----------
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry }); // CPU, memory, event-loop lag, GC

// RED metrics: Rate and Errors are counts of this histogram by status; Duration is its buckets.
const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration by route pattern and status",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const s3Duration = new client.Histogram({
  name: "ministore_s3_request_duration_seconds",
  help: "Duration of each S3 API call to MinIO",
  labelNames: ["operation", "outcome"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const uploadedBytes = new client.Counter({
  name: "ministore_uploaded_bytes_total",
  help: "Bytes accepted by uploads (new files and new versions)",
  registers: [registry],
});

export const lifecycleCounter = new client.Counter({
  name: "ministore_lifecycle_items_total",
  help: "Items handled by the lifecycle job",
  labelNames: ["task"] as const, // trash_purged | versions_pruned | orphans_deleted | dangling_found
  registers: [registry],
});

/**
 * Logs one line per request and records its duration. Attaches a request id (taken from the
 * caller's X-Request-Id if it looks sane, otherwise generated) to the log line and the response,
 * so a user's error report can be matched to the server log.
 */
export const requestObserver: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  const id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", id);
  const stop = httpDuration.startTimer();

  res.on("finish", () => {
    // The route PATTERN ("/files/:id"), never the raw URL: one label value per file id would create
    // millions of time series and take Prometheus down (high cardinality).
    // Express resets req.baseUrl when an error leaves a router, so app.ts records the mount path.
    const base: string = res.locals.routeBase ?? "";
    const route = req.route ? (base + req.route.path).replace(/(.)\/$/, "$1") : base ? `${base}/*` : "unmatched";
    const seconds = stop({ method: req.method, route, status_code: res.statusCode });
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]({
      reqId: id,
      method: req.method,
      route,
      status: res.statusCode,
      ms: Math.round(seconds * 1000),
      userId: req.userId,
    }, "request");
  });
  next();
};

/** Metrics live on their own port, bound to localhost: never exposed on the public API port. */
export function createMetricsApp(
  collect: () => Promise<string> = () => registry.metrics(),
  contentType: string = registry.contentType,
) {
  const app = express();
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", contentType);
    res.send(await collect());
  });
  return app;
}
