import type { Request, RequestHandler } from "express";
import { HttpError } from "./errors";

/** Headers for a JSON-only API: nothing may be framed, sniffed, cached, or run as a page. */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff", // never guess a type: a .txt must not run as HTML
    "X-Frame-Options": "DENY", // no clickjacking via <iframe>
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store", // responses are per-user; shared caches must not keep them
  });
  next();
};

/**
 * Fixed-window rate limiter: at most `max` requests per `windowMs` for each key.
 * ponytail: counts live in this process's memory, so they reset on restart and aren't shared
 * between instances. Move them to Redis when the API runs as more than one process.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}): RequestHandler {
  const key = opts.key ?? ((req) => req.ip ?? "unknown");
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); // bound memory
    }
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(k, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      throw new HttpError(429, "Too many requests, try again later");
    }
    next();
  };
}
