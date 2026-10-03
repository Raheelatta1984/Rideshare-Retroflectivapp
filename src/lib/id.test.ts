import { describe, expect, it } from "vitest";
import {
  formatPair,
  isValidPairCode,
  normalizePairCode,
  packetId,
  pairCode,
  peerId,
  relayTag,
  uid,
  verificationCode,
} from "./id";

describe("uid", () => {
  // Regression: a mangled template literal shipped where the prefix and
  // timestamp were never interpolated, so uid("drv") returned the literal
  // string "\( {prefix}_ \){timestamp}<random>" for every driver, ride and log.
  it("keeps the caller's prefix", () => {
    expect(uid("drv").startsWith("drv_")).toBe(true);
    expect(uid("ride").startsWith("ride_")).toBe(true);
    expect(uid("tablog").startsWith("tablog_")).toBe(true);
  });

  it("never leaks template placeholders into the id", () => {
    const value = uid("drv");
    expect(value).not.toContain("{prefix}");
    expect(value).not.toContain("{timestamp}");
    expect(value).not.toContain("\\");
  });

  it("is unique across rapid calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => uid("x")));
    expect(ids.size).toBe(500);
  });

  it("is distinguishable per prefix", () => {
    expect(uid("drv").split("_")[0]).toBe("drv");
    expect(uid("ride").split("_")[0]).toBe("ride");
  });
});

describe("pairCode / formatPair / isValidPairCode", () => {
  it("generates six uppercase alphanumerics", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = pairCode();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
      expect(isValidPairCode(code)).toBe(true);
    }
  });

  it("rejects malformed codes", () => {
    expect(isValidPairCode("7K2M9")).toBe(false);
    expect(isValidPairCode("7K2M9QL")).toBe(false);
    expect(isValidPairCode("7k2m9q")).toBe(false);
  });

  it("formats for display", () => {
    expect(formatPair("7K2M9Q")).toBe("7K2 M9Q");
    expect(formatPair("abc")).toBe("ABC");
    expect(formatPair(null)).toBe("");
  });
});

describe("verificationCode", () => {
  it("returns four digits", () => {
    expect(verificationCode()).toMatch(/^[1-9][0-9]{3}$/);
  });
});

describe("sync identities", () => {
  // The phone has to know which peer id to dial before connecting, so these
  // must be deterministic functions of the pair code and role.
  it("builds deterministic peer ids per role", () => {
    expect(peerId("host", "7K2M9Q")).toBe("retroflex-7K2M9Q-host");
    expect(peerId("display", "7K2M9Q")).toBe("retroflex-7K2M9Q-display");
  });

  it("keeps host and display apart for the same code", () => {
    expect(peerId("host", "AAAAAA")).not.toBe(peerId("display", "AAAAAA"));
  });

  it("normalises messy codes", () => {
    expect(peerId("host", "7k2-m9 q")).toBe("retroflex-7K2M9Q-host");
    expect(normalizePairCode("?display=7K2M")).toBe("DISPLAY7K2M");
  });

  it("does not collide across pair codes", () => {
    expect(peerId("host", "AAAAAA")).not.toBe(peerId("host", "BBBBBB"));
  });

  it("builds ack packet ids with the expected shape", () => {
    const value = packetId();
    expect(value).toMatch(/^pkt_[a-z0-9]+_[a-z0-9]+$/);
    expect(value).not.toContain("{");
    expect(new Set(Array.from({ length: 200 }, () => packetId())).size).toBe(200);
  });

  it("tags logs with code and role", () => {
    expect(relayTag("7k2m9q", "host")).toBe("[Retroflex 7K2M9Q/host]");
  });
});
