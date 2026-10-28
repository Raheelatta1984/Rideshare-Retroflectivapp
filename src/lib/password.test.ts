import { describe, expect, it } from "vitest";
import {
  PASSWORD_ITERATIONS,
  PASSWORD_SCHEME,
  constantTimeEqualText,
  hashPassword,
  isPasswordHash,
  verifyPassword,
} from "./password";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("password hashing", () => {
  it("stores a salted PBKDF2 record and never the password itself", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(isPasswordHash(hash)).toBe(true);
    expect(hash.startsWith(`${PASSWORD_SCHEME}$${PASSWORD_ITERATIONS}$`)).toBe(true);
    expect(hash).not.toContain("correct horse");

    // Same password, different salt: two records for one password must not
    // reveal that the passwords match.
    const again = await hashPassword("correct horse battery staple");
    expect(again).not.toBe(hash);
  });

  it("verifies the right password and rejects everything else", async () => {
    const hash = await hashPassword("s3cret-passphrase");

    expect((await verifyPassword(hash, "s3cret-passphrase")).ok).toBe(true);
    expect((await verifyPassword(hash, "s3cret-passphras")).ok).toBe(false);
    expect((await verifyPassword(hash, "")).ok).toBe(false);
    expect((await verifyPassword(hash, "S3CRET-PASSPHRASE")).ok).toBe(false);
  });

  it("refuses an empty credential, which is what keeps a seeded account locked", async () => {
    expect(await verifyPassword("", "anything at all")).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword(null, "anything at all")).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword(undefined, "anything at all")).toEqual({ ok: false, needsRehash: false });
    await expect(hashPassword("")).rejects.toThrow();
  });

  it("accepts a legacy clear-text record once and asks for a rehash", async () => {
    expect(await verifyPassword("old-cleartext-password", "old-cleartext-password")).toEqual({
      ok: true,
      needsRehash: true,
    });
    expect((await verifyPassword("old-cleartext-password", "other")).ok).toBe(false);
  });

  it("asks for a rehash when a record was made with fewer iterations", async () => {
    const password = "an-older-record-passphrase";
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 },
      key,
      256,
    );
    const record = `${PASSWORD_SCHEME}$1000$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;

    expect(await verifyPassword(record, password)).toEqual({ ok: true, needsRehash: true });
    expect((await verifyPassword(record, `${password}!`)).ok).toBe(false);
  });

  it("rejects malformed records instead of throwing", async () => {
    const malformed = [
      "pbkdf2-sha256$0$c2FsdA==$aGFzaA==",
      "pbkdf2-sha256$210000$not-base64!$aGFzaA==",
      "pbkdf2-sha256$abc$c2FsdA==$aGFzaA==",
      "pbkdf2$210000$c2FsdA==$aGFzaA==",
      "pbkdf2-sha256$210000$c2FsdA==",
    ];
    for (const record of malformed) {
      await expect(verifyPassword(record, "whatever")).resolves.toMatchObject({ ok: false });
    }
  });

  it("compares text without exiting on the first difference", () => {
    expect(constantTimeEqualText("123456", "123456")).toBe(true);
    expect(constantTimeEqualText("123456", "123457")).toBe(false);
    expect(constantTimeEqualText("123456", "12345")).toBe(false);
  });
});
