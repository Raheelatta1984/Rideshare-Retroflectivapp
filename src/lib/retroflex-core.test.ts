import { describe, expect, it } from "vitest";
import {
  normalizeHashPath,
  normalizePosition,
  sanitizePairCode,
} from "./retroflex-core";

describe("Retroflex core helpers", () => {
  it("sanitizes pair codes to alphanumeric", () => {
    expect(sanitizePairCode("7K2M9Q")).toBe("7K2M9Q");
    expect(sanitizePairCode("?display=7K2M")).toBe("display7K2M");
    expect(sanitizePairCode(" a-1_b ")).toBe("a1b");
  });

  it("normalizes tablet position values", () => {
    expect(normalizePosition("front")).toBe("front");
    expect(normalizePosition("rear")).toBe("rear");
    expect(normalizePosition(null)).toBe("rear");
  });

  it("normalizes hash route paths consistently", () => {
    expect(normalizeHashPath("/lab")).toBe("/lab");
    expect(normalizeHashPath("lab")).toBe("/lab");
    expect(normalizeHashPath("")).toBe("/");
    expect(normalizeHashPath(null)).toBe("/");
  });
});