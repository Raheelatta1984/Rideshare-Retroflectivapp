import { describe, expect, it } from "vitest";
import type { QueryResult } from "./types";
import { createReadRouter } from "./replicas";
import { createMemoryMemcached, createReadThroughCache } from "../cache/memcached";
import { createCampaignStore } from "./campaignStore";

/**
 * End-to-end read path: cache → replica → primary with generation-stamped
 * list keys. This is the "too many reads" regression test — a polling fleet
 * must hit the database once per generation, not once per poll.
 */

function db() {
  const queries: Array<{ sql: string; params?: readonly unknown[]; target: string }> = [];
  const rows = [
    { id: "cmp_1", title: "One", payload: {}, approval_state: "approved", compliance_mode: null, updated_at: "2026-10-01T00:00:00Z" },
    { id: "cmp_2", title: "Two", payload: {}, approval_state: "draft", compliance_mode: null, updated_at: "2026-10-02T00:00:00Z" },
  ];
  const target = (name: string) => ({
    async query<R>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
      queries.push({ sql, params, target: name });
      return { rows: rows as unknown as R[], rowCount: rows.length };
    },
  });
  return { queries, rows, primary: target("primary"), replica: target("replica") };
}

describe("createCampaignStore read path", () => {
  it("answers a polling fleet of list() calls with one database read", async () => {
    const { queries, rows, primary, replica } = db();
    const cache = createReadThroughCache({ client: createMemoryMemcached() });
    const router = createReadRouter({ primary, replicas: [replica], cache });
    const store = createCampaignStore({ router });

    for (let i = 0; i < 25; i += 1) {
      expect(await store.list()).toEqual(rows);
    }
    // One replica query total; the primary saw none of the polls.
    expect(queries.filter((q) => q.target === "replica")).toHaveLength(1);
    expect(queries.filter((q) => q.target === "primary")).toHaveLength(0);
    expect(router.stats().cacheHits).toBe(24);
    expect(router.stats().replicaServed).toBe(1);
  });

  it("re-keys the list cache after a write (generation bump)", async () => {
    const { queries, primary, replica } = db();
    const cache = createReadThroughCache({ client: createMemoryMemcached() });
    const router = createReadRouter({ primary, replicas: [replica], cache });
    const store = createCampaignStore({ router });

    await store.list();
    await store.upsert({ id: "cmp_3", title: "Three", payload: {}, approval_state: "draft" });
    await store.list();

    const listReads = queries.filter((q) => q.sql.includes("from campaigns") && q.target !== "primary");
    expect(listReads).toHaveLength(2); // cache miss again after the bump
    expect(queries.some((q) => q.sql.includes("on conflict"))).toBe(true);
  });

  it("drops the cached item on upsert and delete", async () => {
    const { primary, replica } = db();
    const cache = createReadThroughCache({ client: createMemoryMemcached() });
    const router = createReadRouter({ primary, replicas: [replica], cache });
    const store = createCampaignStore({ router });

    await store.get("cmp_1");
    await cache.set("campaigns:item:cmp_1", { id: "cached" });
    await store.upsert({ id: "cmp_1", title: "One", payload: {}, approval_state: "approved" });
    expect(await cache.get("campaigns:item:cmp_1")).toBeUndefined();

    await cache.set("campaigns:item:cmp_1", { id: "cached" });
    await store.remove("cmp_1");
    expect(await cache.get("campaigns:item:cmp_1")).toBeUndefined();
  });

  it("negative-caches absent IDs and bypasses DB for definite Bloom misses", async () => {
    let dbReads = 0;
    const primary = {
      async query<R>(sql: string): Promise<QueryResult<R>> {
        if (sql.includes("from campaigns")) dbReads += 1;
        return { rows: [] as R[], rowCount: 0 };
      },
    };
    const cache = createReadThroughCache({ client: createMemoryMemcached() });
    const router = createReadRouter({ primary, cache });
    const store = createCampaignStore({ router, knownCampaignIds: ["known-id"] });

    expect(await store.get("not-in-snapshot")).toBeNull();
    expect(dbReads).toBe(0);
    expect(await store.get("known-id")).toBeNull();
    expect(await store.get("known-id")).toBeNull();
    expect(dbReads).toBe(1); // the second absent-row request hits negative cache

    await store.upsert({ id: "created-id", title: "Created", payload: {}, approval_state: "draft" });
    expect(await store.get("created-id")).toBeNull(); // upsert extended the Bloom filter
    expect(dbReads).toBe(2);
  });

  it("routes since-based polls through the same cache discipline", async () => {
    const { queries, primary, replica } = db();
    const cache = createReadThroughCache({ client: createMemoryMemcached() });
    const router = createReadRouter({ primary, replicas: [replica], cache });
    const store = createCampaignStore({ router });

    await store.list({ since: 1000 });
    await store.list({ since: 1000 });
    await store.list({ since: 2000 });

    const listReads = queries.filter((q) => q.sql.includes("from campaigns"));
    expect(listReads).toHaveLength(2); // two variants → two loads; the repeat hit cache
    expect(listReads.map((q) => q.params?.[0])).toEqual(["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:02.000Z"]);
  });
});
