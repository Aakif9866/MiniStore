import { createApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";

const server = createApp().listen(config.PORT, () => {
  console.log(`MiniStore API listening on http://127.0.0.1:${config.PORT}`);
});

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
