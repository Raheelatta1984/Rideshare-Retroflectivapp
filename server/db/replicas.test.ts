import { describe, expect, it } from "vitest";
import type { QueryResult } from "./types";
import { createReadRouter } from "./replicas";
import { createReadThroughCache, createMemoryMemcached } from "../cache/memcached";

function fakeTarget(name: string, options: { fail?: boolean } = {}) {
  const calls: string[] = [];
  return {
    name,
    calls,
    async query<R>(sql: string): Promise<QueryResult<R>> {
      calls.push(sql);
      if (options.fail) throw new Error(`${name} is down`);
      return { rows: [{ source: name }] as unknown as R[], rowCount: 1 };
    },
  };
}

describe("createReadRouter", () => {
  it("routes writes to the primary and reads to replicas", async () => {
    const primary = fakeTarget("primary");
    const replicaA = fakeTarget("replica-a");
    const replicaB = fakeTarget("replica-b");
    const router = createReadRouter({ primary, replicas: [replicaA, replicaB] });

    await router.write("insert into t values (1)");
    expect(primary.calls).toHaveLength(1);
    expect(replicaA.calls).toHaveLength(0);

    await router.read("select * from t");
    await router.read("select * from t");
    expect(primary.calls).toHaveLength(1); // reads never touched the primary
    expect(replicaA.calls.length + replicaB.calls.length).toBe(2);
  });

  it("round-robins reads across healthy replicas", async () => {
    const primary = fakeTarget("primary");
    const replicas = [fakeTarget("r1"), fakeTarget("r2"), fakeTarget("r3")];
    const router = createReadRouter({ primary, replicas });

    for (let i = 0; i < 6; i += 1) await router.read("select 1");
    expect(replicas.map((r) => r.calls.length)).toEqual([2, 2, 2]);
  });

  it("quarantines a failing replica and falls back to the primary", async () => {
    const primary = fakeTarget("primary");
    const bad = fakeTarget("bad", { fail: true });
    const router = createReadRouter({ primary, replicas: [bad], cooldownMs: 60_000 });

    const result = await router.read<{ source: string }>("select 1");
    expect(result.rows[0].source).toBe("primary");
    expect(router.healthyReplicas()).toBe(0);
    expect(router.stats().replicaFailures).toBe(1);
    expect(router.stats().primaryServed).toBe(1);

    // Still quarantined on the next read: straight to primary, no re-probe.
    await router.read("select 1");
    expect(bad.calls).toHaveLength(1);
    expect(router.stats().primaryServed).toBe(2);
  });

  it("re-probes a quarantined replica after the cooldown", async () => {
    let now = 0;
    const primary = fakeTarget("primary");
    const flaky = fakeTarget("flaky", { fail: true });
    const router = createReadRouter({
      primary,
      replicas: [flaky],
      cooldownMs: 1000,
      clock: () => now,
    });

    await router.read("select 1");
    expect(flaky.calls).toHaveLength(1);
    now = 500;
    await router.read("select 1");
    expect(flaky.calls).toHaveLength(1); // still cooling down

    // The replica recovers; after the cooldown it serves again.
    (flaky as unknown as { query: unknown }).query = async (sql: string) => {
      flaky.calls.push(sql);
      return { rows: [{ source: "flaky" }], rowCount: 1 };
    };
    now = 2000;
    const result = await router.read<{ source: string }>("select 1");
    expect(result.rows[0].source).toBe("flaky");
    expect(router.healthyReplicas()).toBe(1);
  });

  it("serves strong-consistency reads from the primary", async () => {
    const primary = fakeTarget("primary");
    const replica = fakeTarget("replica");
    const router = createReadRouter({ primary, replicas: [replica] });

    await router.read("select 1", [], { strongConsistency: true });
    expect(primary.calls).toHaveLength(1);
    expect(replica.calls).toHaveLength(0);
    expect(router.stats().primaryServed).toBe(1);
  });

  it("serves cached reads without touching any database", async () => {
    const primary = fakeTarget("primary");
    const replica = fakeTarget("replica");
    const cache = createReadThroughCache({ client: createMemoryMemcached() });
    const router = createReadRouter({ primary, replicas: [replica], cache });

    const first = await router.read("select * from campaigns", [], { cacheKey: "c", ttlSeconds: 30 });
    const second = await router.read("select * from campaigns", [], { cacheKey: "c", ttlSeconds: 30 });

    expect(second.rows).toEqual(first.rows);
    expect(replica.calls).toHaveLength(1); // second read was a cache hit
    expect(router.stats().cacheHits).toBe(1);
  });

  it("invalidates and bumps on write", async () => {
    const primary = fakeTarget("primary");
    const cache = createReadThroughCache({ client: createMemoryMemcached() });
    const router = createReadRouter({ primary, cache });

    await cache.set("item:1", "old");
    await router.write("update t", [], { cacheKeys: ["item:1"], bumpKeys: ["list:gen"] });
    expect(await cache.get("item:1")).toBeUndefined();
    expect(await cache.get<number>("list:gen")).toBe(1);
    expect(await cache.get<number>("list:gen")).toBe(1); // bump happened once
  });

  it("exposes the cache for callers that need generation reads", async () => {
    const cache = createReadThroughCache({ client: createMemoryMemcached() });
    const router = createReadRouter({ primary: fakeTarget("primary"), cache });
    expect(router.cache).toBe(cache);
  });
});
