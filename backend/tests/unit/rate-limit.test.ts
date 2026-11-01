import type { Request, Response } from "express";
import { rateLimit } from "../../src/security";

function fakeRes() {
  const headers: Record<string, unknown> = {};
  return { headers, setHeader: (k: string, v: unknown) => (headers[k] = v) } as unknown as Response & {
    headers: Record<string, unknown>;
  };
}
const req = (ip: string) => ({ ip }) as Request;

describe("rateLimit", () => {
  afterEach(() => jest.useRealTimers());

  it("allows `max` requests per window, then throws 429 with Retry-After", () => {
    const limit = rateLimit({ windowMs: 60_000, max: 2 });
    const next = jest.fn();
    const res = fakeRes();
    limit(req("1.1.1.1"), res, next);
    limit(req("1.1.1.1"), res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(() => limit(req("1.1.1.1"), res, next)).toThrow(expect.objectContaining({ status: 429 }));
    expect(res.headers["Retry-After"]).toBe(60);
  });

  it("counts each key separately", () => {
    const limit = rateLimit({ windowMs: 60_000, max: 1 });
    const next = jest.fn();
    limit(req("1.1.1.1"), fakeRes(), next);
    limit(req("2.2.2.2"), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh window once the old one expires", () => {
    jest.useFakeTimers();
    const limit = rateLimit({ windowMs: 1000, max: 1 });
    const next = jest.fn();
    limit(req("1.1.1.1"), fakeRes(), next);
    jest.advanceTimersByTime(1001);
    limit(req("1.1.1.1"), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
