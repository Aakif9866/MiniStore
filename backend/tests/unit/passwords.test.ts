import { hashPassword, verifyPassword } from "../../src/auth";

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("correct horsE", hash)).toBe(false);
  });

  it("never stores the password and salts every hash", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toContain("same-password");
    expect(a).not.toEqual(b); // different random salt each time
    expect(a.startsWith("scrypt$32768$8$1$")).toBe(true); // parameters travel with the hash
  });
});
