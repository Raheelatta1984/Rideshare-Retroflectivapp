import { describe, expect, it } from "vitest";
import type { PgPoolLike, QueryResult } from "./db/pgbouncer";
import { createDataPlane, readDataPlaneConfig } from "./config";

class FakePool implements PgPoolLike {
  constructor(public config: Record<string, unknown>) {}
  async query<R>(): Promise<QueryResult<R>> {
    return { rows: [] as R[], rowCount: 0 };
  }
  async connect() {
    return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
  }
  async end(): Promise<void> {}
}

const driver = { Pool: FakePool };

describe("readDataPlaneConfig", () => {
  it("requires DATABASE_URL and rewrites Neon direct to -pooler", () => {
    expect(() => readDataPlaneConfig({})).toThrow(/DATABASE_URL/);
    const config = readDataPlaneConfig({
      DATABASE_URL: "postgres://u:p@ep-x-123.aws.neon.tech/db",
      DATABASE_REPLICA_URLS: "postgres://u:p@replica-a/db, postgres://u:p@replica-b/db",
      MEMCACHED_URLS: "mc-a:11211,mc-b:11211",
    });
    expect(config.primary.connectionString).toContain("ep-x-123-pooler");
    expect(config.replicaUrls).toHaveLength(2);
    expect(config.memcachedServers).toEqual(["mc-a:11211", "mc-b:11211"]);
    expect(config.primary.settings.poolMode).toBe("transaction");
  });

  it("parses pool sizing overrides", () => {
    const config = readDataPlaneConfig({
      DATABASE_URL: "postgres://u:p@pooler:6543/db",
      PG_POOL_MODE: "session",
      PG_MAX_CLIENT_CONNECTIONS: "4",
      PG_DEFAULT_POOL_SIZE: "10",
    });
    expect(config.primary.settings.poolMode).toBe("session");
    expect(config.primary.settings.maxClientConnections).toBe(4);
    expect(config.primary.settings.defaultPoolSize).toBe(10);
  });
});

describe("createDataPlane", () => {
  it("composes primary pool, replica router and cached campaign store", () => {
    const plane = createDataPlane(
      {
        DATABASE_URL: "postgres://u:p@ep-x-123.aws.neon.tech/db",
        DATABASE_REPLICA_URLS: "postgres://u:p@replica-a/db",
      },
      {
        driver,
        replicas: [{ query: async () => ({ rows: [], rowCount: 0 }) }],
      },
    );

    expect(plane.config.primary.connectionString).toContain("-pooler");
    expect(plane.router.healthyReplicas()).toBe(1);
    expect(plane.campaigns).toBeDefined();
    expect(plane.images).toBeUndefined(); // no IMAGE_MACHINE_MAP in this env
    expect(plane.primaryPool.stats().mode).toBe("transaction");
  });
});
