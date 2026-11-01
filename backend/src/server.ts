import cluster from "node:cluster";
import client from "prom-client";
import { createApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { runLifecycle } from "./lifecycle";
import { createMetricsApp, logger, registry } from "./observability";

// Node runs JavaScript on one thread, so one process uses one CPU core (Phase 9 measured this as
// THE bottleneck). With WEB_CONCURRENCY > 1 a primary process forks that many workers; they share
// the listening port and the OS spreads connections across them.
//
//   primary: forks/re-forks workers, serves /metrics (merged from all workers), runs the lifecycle job
//   workers: serve the API
//
// ponytail: the auth rate limiter is in-memory per worker, so the effective limit is
// WEB_CONCURRENCY × AUTH_RATE_LIMIT. A shared store (Redis) fixes it when that matters.
const clustered = config.WEB_CONCURRENCY > 1;

if (clustered && cluster.isPrimary) {
  logger.info(`Primary ${process.pid}: starting ${config.WEB_CONCURRENCY} workers`);
  let stopping = false;
  for (let i = 0; i < config.WEB_CONCURRENCY; i++) cluster.fork();
  // A crashed worker is replaced, so one bad request can't take the whole API down.
  cluster.on("exit", (worker, code, signal) => {
    if (stopping) return;
    logger.error(`Worker ${worker.process.pid} died (${signal ?? code}); starting a new one`);
    cluster.fork();
  });

  const aggregator = new client.AggregatorRegistry();
  startMetrics(createMetricsApp(() => aggregator.clusterMetrics(), aggregator.contentType));
  startLifecycle();
  onShutdown(() => {
    stopping = true;
    cluster.disconnect(() => process.exit(0)); // each worker finishes in-flight requests first
  });
} else {
  if (clustered) {
    // Answer the primary's scrape requests. The constructor is what installs the worker's
    // message listener (prom-client 15); setRegistries alone silently times out.
    new client.AggregatorRegistry();
    client.AggregatorRegistry.setRegistries([registry]);
  }
  const server = createApp().listen(config.PORT, () => {
    logger.info(`MiniStore API (pid ${process.pid}) listening on http://127.0.0.1:${config.PORT}`);
  });
  if (!clustered) {
    startMetrics(createMetricsApp());
    startLifecycle();
  }
  onShutdown(() =>
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    }),
  );
}

// Prometheus scrapes this. Separate port on localhost only: metrics reveal internals (routes,
// error rates, memory) and must never be reachable from the internet.
function startMetrics(app: ReturnType<typeof createMetricsApp>) {
  const metricsServer = app.listen(config.METRICS_PORT, config.METRICS_HOST, () => {
    logger.info(`Metrics on http://${config.METRICS_HOST}:${config.METRICS_PORT}/metrics`);
  });
  onShutdown(() => metricsServer.close());
}

// Background lifecycle job (trash purge, version pruning, orphan cleanup). Runs in ONE process.
// ponytail: with several machines, each runs it; take a Postgres advisory lock (pg_try_advisory_lock)
// first so only one does, or run `npm run lifecycle` from cron instead.
function startLifecycle() {
  if (config.LIFECYCLE_INTERVAL_MINUTES <= 0) return;
  setInterval(
    () => void runLifecycle().then((summary) => logger.info({ summary }, "lifecycle run")),
    config.LIFECYCLE_INTERVAL_MINUTES * 60_000,
  ).unref(); // don't keep the process alive just for this timer
}

// Graceful shutdown: stop accepting connections, let in-flight requests finish, then close
// the DB pool. Docker sends SIGTERM on `docker stop`; Ctrl+C sends SIGINT.
function onShutdown(fn: () => void) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info(`${signal} received, shutting down`);
      fn();
    });
  }
}
