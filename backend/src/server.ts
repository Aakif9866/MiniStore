import { createApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { createMetricsApp, logger } from "./observability";
import { runLifecycle } from "./lifecycle";

const server = createApp().listen(config.PORT, () => {
  logger.info(`MiniStore API listening on http://127.0.0.1:${config.PORT}`);
});

// Prometheus scrapes this. Separate port on localhost only: metrics reveal internals (routes,
// error rates, memory) and must never be reachable from the internet.
const metricsServer = createMetricsApp().listen(config.METRICS_PORT, config.METRICS_HOST, () => {
  logger.info(`Metrics on http://${config.METRICS_HOST}:${config.METRICS_PORT}/metrics`);
});

// Background lifecycle job (trash purge, version pruning, orphan cleanup).
// ponytail: every API instance runs it; with several instances, take a Postgres advisory lock
// (pg_try_advisory_lock) first so only one does, or run `npm run lifecycle` from cron instead.
if (config.LIFECYCLE_INTERVAL_MINUTES > 0) {
  setInterval(
    () => void runLifecycle().then((summary) => logger.info({ summary }, "lifecycle run")),
    config.LIFECYCLE_INTERVAL_MINUTES * 60_000,
  ).unref(); // don't keep the process alive just for this timer
}

// Graceful shutdown: stop accepting connections, let in-flight requests finish, then close
// the DB pool. Docker sends SIGTERM on `docker stop`; Ctrl+C sends SIGINT.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    metricsServer.close();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  });
}
