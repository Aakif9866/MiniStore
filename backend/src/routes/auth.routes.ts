import { Router } from "express";
import { z } from "zod";
import { hashPassword, signToken, verifyPassword } from "../auth";
import { prisma } from "../db";
import { HttpError } from "../errors";
import { Prisma } from "../generated/prisma/client";

export const authRouter = Router();

const credentials = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)), // normalise, THEN validate
  password: z.string().min(8).max(128), // upper bound: hashing a 10 MB "password" is a cheap DoS
});

authRouter.post("/register", async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  try {
    const user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password) },
    });
    res.status(201).json({ id: user.id, email: user.email });
  } catch (err) {
    // Let the UNIQUE constraint decide, not a SELECT-then-INSERT (two concurrent
    // registrations could both pass the SELECT).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new HttpError(409, "Email already registered");
    }
    throw err;
  }
});

// Computed once. Used when the email doesn't exist so that login takes the same time either
// way — otherwise response time reveals which emails have accounts.
const dummyHash = hashPassword("dummy-password-for-timing");

authRouter.post("/login", async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
  // Same message for "no such user" and "wrong password".
  if (!user || !ok) throw new HttpError(401, "Invalid email or password");
  res.json({ token: signToken(user.id) });
});
