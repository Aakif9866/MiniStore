import { createApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { runLifecycle } from "./lifecycle";

const server = createApp().listen(config.PORT, () => {
  console.log(`MiniStore API listening on http://127.0.0.1:${config.PORT}`);
});

// Background lifecycle job (trash purge, version pruning, orphan cleanup).
// ponytail: every API instance runs it; with several instances, take a Postgres advisory lock
// (pg_try_advisory_lock) first so only one does, or run `npm run lifecycle` from cron instead.
if (config.LIFECYCLE_INTERVAL_MINUTES > 0) {
  setInterval(
    () => void runLifecycle().then((s) => console.log("Lifecycle run", JSON.stringify(s))),
    config.LIFECYCLE_INTERVAL_MINUTES * 60_000,
  ).unref(); // don't keep the process alive just for this timer
}

// Graceful shutdown: stop accepting connections, let in-flight requests finish, then close
// the DB pool. Docker sends SIGTERM on `docker stop`; Ctrl+C sends SIGINT.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  });
}
