// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertCookieAttributes,
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
  sessionCookieName,
} from "./cookies";

describe("session cookies", () => {
  it("uses the __Host- prefix only when the connection is secure", () => {
    expect(sessionCookieName(true)).toBe("__Host-rf_session");
    expect(sessionCookieName(false)).toBe("rf_session");
  });

  it("serialises every protective attribute", () => {
    const header = serializeSessionCookie("token-value", { secure: true, maxAgeSeconds: 600 });
    expect(header).toBe("__Host-rf_session=token-value; Path=/; Max-Age=600; SameSite=Lax; HttpOnly; Secure");
    expect(() => assertCookieAttributes(header, true)).not.toThrow();
  });

  it("omits Secure only for local development", () => {
    const header = serializeSessionCookie("t", { secure: false, maxAgeSeconds: 60 });
    expect(header.startsWith("rf_session=")).toBe(true);
    expect(header).not.toContain("Secure");
    expect(header).toContain("HttpOnly");
  });

  it("expires the cookie on clear", () => {
    const header = clearSessionCookie({ secure: true });
    expect(header).toContain("Max-Age=0");
    expect(header.startsWith("__Host-rf_session=;")).toBe(true);
  });

  it("rejects a policy-breaking header", () => {
    expect(() => assertCookieAttributes("rf_session=x; Path=/; SameSite=Lax", true)).toThrow(/HttpOnly/);
    expect(() => assertCookieAttributes("__Host-x=1; Path=/; HttpOnly; SameSite=Lax", true)).toThrow(/Secure/);
    expect(() => assertCookieAttributes("rf_session=1; Path=/; HttpOnly; SameSite=Lax; Secure; Domain=example.com", false)).toThrow(
      /Domain/,
    );
  });

  it("parses only the named cookie and refuses header injection", () => {
    expect(readCookie("a=1; __Host-rf_session=abc; b=2", "__Host-rf_session")).toBe("abc");
    expect(readCookie("__Host-rf_session=", "__Host-rf_session")).toBe("");
    expect(readCookie(null, "__Host-rf_session")).toBeNull();
    expect(readCookie("__Host-rf_session=abc%0d%0aSet-Cookie:x", "__Host-rf_session")).toBeNull();
  });
});
