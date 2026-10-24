import { describe, expect, it } from "vitest";
import { createMemoryMemcached } from "../cache/memcached";
import { createRateLimiter, withRateLimit } from "./rateLimit";

describe("request rate limiter", () => {
  it("enforces a shared fixed-window limit across limiter instances", async () => {
    const cache = createMemoryMemcached();
    const first = createRateLimiter({ client: cache, namespace: "test" });
    const second = createRateLimiter({ client: cache, namespace: "test" });

    expect((await first.check("client-1", 2, 60)).allowed).toBe(true);
    expect((await second.check("client-1", 2, 60)).remaining).toBe(0);
    const rejected = await first.check("client-1", 2, 60);
    expect(rejected).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: expect.any(Number) });
    expect((await first.check("client-2", 2, 60)).allowed).toBe(true);
  });

  it("starts a new window at the fixed reset boundary", async () => {
    let now = 12_000;
    const limiter = createRateLimiter({ clock: () => now });
    expect((await limiter.check("ip", 1, 10)).resetAt).toBe(20_000);
    expect((await limiter.check("ip", 1, 10)).allowed).toBe(false);
    now = 20_000;
    expect((await limiter.check("ip", 1, 10)).allowed).toBe(true);
  });

  it("returns 429 before invoking a handler after the request quota is exhausted", async () => {
    const limiter = createRateLimiter();
    let handled = 0;
    const route = withRateLimit(
      async () => {
        handled += 1;
        return new Response("ok");
      },
      { limiter, limit: 1, windowSeconds: 60, identifier: () => "trusted-user-1" },
    );

    expect((await route(new Request("https://example.test/api"))).status).toBe(200);
    const denied = await route(new Request("https://example.test/api"));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBeTruthy();
    expect(handled).toBe(1);
  });

  it("validates limits and bounds local fallback state", async () => {
    const limiter = createRateLimiter({ maxLocalKeys: 100 });
    await expect(limiter.check("", 1, 60)).rejects.toThrow(/identifier/);
    await expect(limiter.check("ip", 0, 60)).rejects.toThrow(/positive integer/);
    expect((await limiter.check("ip", 1, 60)).allowed).toBe(true);
  });
});
