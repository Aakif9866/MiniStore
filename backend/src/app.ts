import express from "express";
import { errorHandler } from "./errors";
import { authRouter } from "./routes/auth.routes";
import { filesRouter } from "./routes/files.routes";

// Builds the app without listening, so tests can drive it in-process with Supertest.
export function createApp() {
  const app = express();
  app.disable("x-powered-by"); // don't advertise the framework

  app.use(express.json({ limit: "10kb" })); // JSON bodies are tiny; files go via multipart

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use("/auth", authRouter);
  app.use("/files", filesRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler); // Express 5 forwards rejected async handlers here automatically
  return app;
}
