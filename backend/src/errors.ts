import type { ErrorRequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError, z } from "zod";

/** An error that is safe to show the client, with the HTTP status to use. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Headers already sent (e.g. a download stream broke midway): we can't send JSON any more.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: z.flattenError(err).fieldErrors });
    return;
  }
  if (err instanceof MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(status).json({ error: err.message });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }

  // Anything else is a bug or an infrastructure failure. Log the details, hide them from the
  // client (stack traces leak internals).
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
