import { describe, expect, it } from "vitest";
import type { LeasedConnection, PgPoolLike, QueryResult } from "./pgbouncer";
import {
  TRANSACTION_POOL_DEFAULTS,
  createPgBouncerPool,
  isPoolerUrl,
  mergeSettings,
  pgPoolConfig,
  toDirectUrl,
  toPoolerUrl,
} from "./pgbouncer";

/* ------------------------------------------------------------------ *
 * URL helpers
 * ------------------------------------------------------------------ */

describe("pooler URL detection and rewriting", () => {
  it("spots pooled endpoints", () => {
    expect(isPoolerUrl("postgres://u:p@ep-cool-123-pooler.aws.neon.tech/db")).toBe(true);
    expect(isPoolerUrl("postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/db")).toBe(true);
    expect(isPoolerUrl("postgres://u:p@db.example.com:6543/db")).toBe(true);
    expect(isPoolerUrl("postgres://u:p@db.example.com/db?pgbouncer=true")).toBe(true);
  });

  it("spots direct endpoints", () => {
    expect(isPoolerUrl("postgres://u:p@ep-cool-123.aws.neon.tech/db")).toBe(false);
    expect(isPoolerUrl("postgres://u:p@db.example.com:5432/db")).toBe(false);
    expect(isPoolerUrl("postgres://u:p@db.abcdef.supabase.co/db")).toBe(false);
  });

  it("rewrites Neon direct endpoints to their -pooler twin", () => {
    expect(toPoolerUrl("postgres://u:p@ep-cool-123.aws.neon.tech/neondb?sslmode=require")).toBe(
      "postgres://u:p@ep-cool-123-pooler.aws.neon.tech/neondb?sslmode=require",
    );
  });

  it("leaves already-pooled and non-Neon URLs untouched", () => {
    const pooled = "postgres://u:p@ep-cool-123-pooler.aws.neon.tech/db";
    expect(toPoolerUrl(pooled)).toBe(pooled);
    const supabase = "postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    expect(toPoolerUrl(supabase)).toBe(supabase);
  });

  it("round-trips back to the direct form", () => {
    const direct = "postgres://u:p@ep-cool-123.aws.neon.tech/db";
    expect(toDirectUrl(toPoolerUrl(direct))).toBe(direct);
    expect(toDirectUrl("postgres://u:p@ep-cool-123-pooler.aws.neon.tech/db?pgbouncer=true")).toBe(
      "postgres://u:p@ep-cool-123.aws.neon.tech/db",
    );
  });
});

describe("pgPoolConfig", () => {
  it("derives client slots from the pooler settings", () => {
    const config = pgPoolConfig({
      connectionString: "postgres://u:p@pooler.example:6543/db",
      settings: mergeSettings({ maxClientConnections: 8, minPoolSize: 2, checkoutTimeoutMs: 2500 }),
      applicationName: "tests",
    });
    expect(config).toMatchObject({
      max: 8,
      min: 2,
      connectionTimeoutMillis: 2500,
      application_name: "tests",
    });
  });

  it("defaults to transaction pooling", () => {
    expect(TRANSACTION_POOL_DEFAULTS.poolMode).toBe("transaction");
  });
});

/* ------------------------------------------------------------------ *
 * Pool wrapper (fake driver)
 * ------------------------------------------------------------------ */

interface FakeConn extends LeasedConnection {
  log: string[];
  released: boolean;
}

function fakeDriver() {
  const log: string[] = [];
  const created: Array<{ config: Record<string, unknown> }> = [];

  const makeConn = (): FakeConn => {
    const connLog: string[] = [];
    return {
      log: connLog,
      released: false,
      async query<R>(sql: string): Promise<QueryResult<R>> {
        connLog.push(sql);
        log.push(sql);
        return { rows: [] as R[], rowCount: 0 };
      },
      release() {
        this.released = true;
      },
    };
  };

  class FakePool implements PgPoolLike {
    connections: FakeConn[] = [];
    constructor(public config: Record<string, unknown>) {
      created.push(this);
    }
    async query<R>(sql: string): Promise<QueryResult<R>> {
      log.push(`pool:${sql}`);
      return { rows: [] as R[], rowCount: 0 };
    }
    async connect(): Promise<LeasedConnection> {
      const conn = makeConn();
      this.connections.push(conn);
      return conn;
    }
    async end(): Promise<void> {
      log.push("end");
    }
  }

  return { Pool: FakePool, log, created };
}

describe("createPgBouncerPool", () => {
  it("checks out and returns leases, always", async () => {
    const driver = fakeDriver();
    const pool = createPgBouncerPool(
      { connectionString: "postgres://u:p@pooler:6543/db", settings: mergeSettings({ poolMode: "transaction" }) },
      driver,
    );

    await pool.withConnection(async (conn) => {
      await conn.query("select 1");
    });

    const internal = driver.created[0] as unknown as { connections: FakeConn[] };
    expect(internal.connections).toHaveLength(1);
    expect(internal.connections[0].released).toBe(true);
    expect(pool.stats().checkouts).toBe(1);
    expect(pool.stats().returns).toBe(1);
    expect(pool.stats().resets).toBe(0); // transaction mode: nothing to scrub
  });

  it("scrubs session state only in session mode", async () => {
    const driver = fakeDriver();
    const pool = createPgBouncerPool(
      { connectionString: "postgres://u:p@pooler:6543/db", settings: mergeSettings({ poolMode: "session" }) },
      driver,
    );
    await pool.withConnection(async (conn) => {
      await conn.query("set search_path = x");
    });
    const internal = driver.created[0] as unknown as { connections: FakeConn[] };
    expect(internal.connections[0].log).toContain("discard all");
    expect(pool.stats().resets).toBe(1);
  });

  it("wraps work in begin/commit and rolls back on failure", async () => {
    const driver = fakeDriver();
    const pool = createPgBouncerPool(
      { connectionString: "postgres://u:p@pooler:6543/db", settings: mergeSettings() },
      driver,
    );

    await pool.withTransaction(async (conn) => {
      await conn.query("insert into t values (1)");
    });

    await expect(
      pool.withTransaction(async (conn) => {
        await conn.query("insert into t values (2)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const internal = driver.created[0] as unknown as { connections: FakeConn[] };
    const first = internal.connections[0].log;
    expect(first).toEqual(["begin", "insert into t values (1)", "commit"]);
    const second = internal.connections[1].log;
    expect(second).toEqual(["begin", "insert into t values (2)", "rollback"]);
    expect(internal.connections.every((c) => c.released)).toBe(true);
    expect(pool.stats().errors).toBe(1);
  });

  it("builds driver config from the pooler settings", () => {
    const driver = fakeDriver();
    createPgBouncerPool(
      {
        connectionString: "postgres://u:p@pooler:6543/db",
        settings: mergeSettings({ maxClientConnections: 3 }),
      },
      driver,
    );
    expect(driver.created[0].config).toMatchObject({ max: 3, application_name: "retroflex-dataplane" });
  });
});
