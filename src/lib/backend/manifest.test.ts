import { beforeAll, describe, expect, it } from "vitest";

/**
 * manifest.ts uses WebCrypto, which jsdom does not expose. Install Node's
 * implementation before importing the module.
 */
let manifest: typeof import("./manifest");

beforeAll(async () => {
  const { webcrypto } = await import("node:crypto");
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  manifest = await import("./manifest");
});

const campaign = (overrides: Record<string, unknown> = {}) => ({
  id: "cmp_1",
  title: "Bondi Coffee",
  enabled: true,
  approved: true,
  assetUrl: "https://cdn.example.com/coffee.png",
  mediaType: "image" as const,
  displaySeconds: 10,
  ...overrides,
});

describe("canonicalize", () => {
  it("is key-order independent", () => {
    expect(manifest.canonicalize({ b: 1, a: 2 })).toBe(manifest.canonicalize({ a: 2, b: 1 }));
  });

  it("keeps array order significant", () => {
    expect(manifest.canonicalize([1, 2])).not.toBe(manifest.canonicalize([2, 1]));
  });

  it("drops undefined values so absent and undefined match", () => {
    expect(manifest.canonicalize({ a: 1, b: undefined })).toBe(manifest.canonicalize({ a: 1 }));
  });
});

describe("issueManifest", () => {
  it("includes only campaigns with a usable asset", () => {
    return manifest
      .issueManifest([
        campaign(),
        campaign({ id: "cmp_2", assetUrl: undefined, assetDataUrl: undefined }),
      ] as never)
      .then((value) => {
        expect(value.entries.map((entry) => entry.id)).toEqual(["cmp_1"]);
      });
  });

  it("prefers the approved remote asset over the cached copy", async () => {
    const value = await manifest.issueManifest([
      campaign({ assetUrl: "https://cdn.example.com/a.png", assetDataUrl: "data:image/png;base64,AAAA" }),
    ] as never);
    expect(value.entries[0].asset).toBe("https://cdn.example.com/a.png");
  });

  it("is deterministic for the same input and timestamp", async () => {
    const a = await manifest.issueManifest([campaign()] as never, { now: 1000, secret: "s" });
    const b = await manifest.issueManifest([campaign()] as never, { now: 1000, secret: "s" });
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("issues unsigned when no secret is configured (and says so)", async () => {
    const value = await manifest.issueManifest([campaign()] as never, { now: 1 });
    expect(value.signature).toBeUndefined();
    expect(await manifest.verifyManifest(value)).toEqual({
      valid: true,
      reason: "unsigned (no signing secret configured)",
    });
  });

  it("carries the schedule window and geo rule into the entry", async () => {
    const value = await manifest.issueManifest([
      campaign({ startAt: 5, endAt: 10, geoRule: { latitude: -33.89, longitude: 151.27, radiusKm: 2 } }),
    ] as never);
    expect(value.entries[0]).toMatchObject({ startAt: 5, endAt: 10 });
    expect(value.entries[0].geoRule?.radiusKm).toBe(2);
  });
});

describe("verifyManifest", () => {
  it("accepts an untouched signed manifest", async () => {
    const value = await manifest.issueManifest([campaign()] as never, { secret: "s3cret", now: 1 });
    expect(await manifest.verifyManifest(value, "s3cret")).toEqual({ valid: true });
  });

  // The whole point of signing: a tampered local copy must be rejected.
  it("rejects a tampered entry", async () => {
    const value = await manifest.issueManifest([campaign()], { secret: "s3cret", now: 1 } as never);
    value.entries[0].title = "Injected Advert";
    const result = await manifest.verifyManifest(value, "s3cret");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  it("rejects an added asset URL", async () => {
    const value = await manifest.issueManifest([campaign()] as never, { secret: "s3cret", now: 1 });
    value.entries[0].asset = "https://evil.example.com/x.png";
    expect((await manifest.verifyManifest(value, "s3cret")).valid).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    const value = await manifest.issueManifest([campaign()] as never, { secret: "s3cret", now: 1 });
    const result = await manifest.verifyManifest(value, "wrong");
    expect(result.valid).toBe(false);
  });

  it("rejects an unsigned manifest when a secret is configured", async () => {
    const value = await manifest.issueManifest([campaign()] as never, { now: 1 });
    const result = await manifest.verifyManifest(value, "s3cret");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("unsigned");
  });

  it("rejects a signature with no secret to check it against", async () => {
    const value = await manifest.issueManifest([campaign()] as never, { secret: "s3cret", now: 1 });
    const result = await manifest.verifyManifest(value);
    expect(result.valid).toBe(false);
  });

  it("rejects malformed input", async () => {
    expect((await manifest.verifyManifest(null as never)).valid).toBe(false);
    expect((await manifest.verifyManifest({ version: 1 } as never)).valid).toBe(false);
  });

  it("rejects an unsupported algorithm", async () => {
    const value = await manifest.issueManifest([campaign()] as never, { secret: "s3cret", now: 1 });
    const result = await manifest.verifyManifest({ ...value, algorithm: "MD5" }, "s3cret");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("unsupported");
  });
});

describe("constantTimeEqual", () => {
  it("compares equal strings and rejects different ones", () => {
    expect(manifest.constantTimeEqual("abcd", "abcd")).toBe(true);
    expect(manifest.constantTimeEqual("abcd", "abce")).toBe(false);
    expect(manifest.constantTimeEqual("abcd", "abcde")).toBe(false);
  });
});
