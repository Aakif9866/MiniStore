import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config";
import { HttpError } from "./errors";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// ---------- Passwords ----------
// scrypt is built into Node and is deliberately slow AND memory-hard (costs N*r*128 bytes = 32 MiB
// here), which makes GPU brute-forcing expensive. Parameters are stored inside the hash, so they
// can be raised later without breaking existing users.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16); // unique per user → identical passwords get different hashes
  const hash = await scryptAsync(password, salt, KEYLEN, { ...PARAMS, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, N, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  // Constant-time compare: `===` stops at the first differing byte, leaking timing information.
  return timingSafeEqual(actual, expected);
}

// ---------- Tokens ----------
export function signToken(userId: string): string {
  return jwt.sign({}, config.JWT_SECRET, {
    subject: userId,
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
    algorithm: "HS256",
  });
}

/** Rejects the request with 401 unless it carries a valid `Authorization: Bearer <jwt>`. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) throw new HttpError(401, "Missing bearer token");

  try {
    // Pin the algorithm: never let the token itself choose how it gets verified.
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof payload === "string" || !payload.sub) throw new Error("no subject");
    req.userId = payload.sub;
  } catch {
    throw new HttpError(401, "Invalid or expired token");
  }
  next();
};
