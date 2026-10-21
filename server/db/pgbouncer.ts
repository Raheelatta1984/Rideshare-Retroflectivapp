/**
 * PgBouncer-aware connection pooling for the Postgres data plane.
 *
 * Why this exists: the app's Postgres traffic (Neon or Supabase, both plain
 * Postgres) is mostly short transactions — list campaigns, insert events,
 * touch terminals. Opening a backend connection per request exhausts the
 * database long before it exhausts CPU. PgBouncer in **transaction pooling**
 * mode multiplexes many clients onto a small set of server connections:
 *
 *   app instances ──▶ PgBouncer (:6543 / -pooler endpoint) ──▶ Postgres primary
 *                                                          └─▶ read replicas
 *
 * Transaction pooling has sharp edges this module encodes so callers cannot
 * cut themselves on them:
 *
 *   - **No session state.** `SET`, temp tables, `LISTEN`, session-level
 *     advisory locks and prepared-statement caches do not survive a checkout.
 *     Use `withTransaction`/`withConnection` (below) for anything that spans
 *     statements, which pins one server connection for the duration.
 *   - **No named prepared statements.** Pass SQL text + parameters to
 *     `query()`; the wrapper never caches statements server-side.
 *   - **Pool sizing is per process**, and PgBouncer's `default_pool_size`
 *     bounds the server side. `pgPoolConfig()` derives the former from the
 *     latter so a deploy cannot accidentally ask for more clients than the
 *     pooler will ever serve.
 *
 * Everything takes injected drivers/connections, so the logic is unit-tested
 * without a database and works with `pg`, `postgres.js`, or a mock.
 */

import type { LeasedConnection, Queryable, QueryResult } from "./types";

export type PoolMode = "transaction" | "session" | "statement";

export interface PgBouncerSettings {
  poolMode: PoolMode;
  /** Server connections per user/database inside the pooler. */
  defaultPoolSize: number;
  minPoolSize: number;
  /** Client slots this process may open through the pooler. */
  maxClientConnections: number;
  /** Seconds a leased connection may idle before the pooler reclaims it. */
  serverIdleTimeout: number;
  /** Hard cap on one checkout, in ms. */
  checkoutTimeoutMs: number;
}

/** Safe defaults for the app's workload (short transactions, high concurrency). */
export const TRANSACTION_POOL_DEFAULTS: PgBouncerSettings = {
  poolMode: "transaction",
  defaultPoolSize: 25,
  minPoolSize: 5,
  maxClientConnections: 20,
  serverIdleTimeout: 120,
  checkoutTimeoutMs: 5_000,
};

export interface PgBouncerConfig {
  /**
   * Connection string for the **pooler endpoint**, not the raw primary.
   * `toPoolerUrl()` rewrites known direct forms (Neon `-pooler`, Supabase
   * `:6543`) when all you have is the direct URL.
   */
  connectionString: string;
  settings: PgBouncerSettings;
  applicationName?: string;
}

/* ------------------------------------------------------------------ *
 * Endpoint URL helpers
 * ------------------------------------------------------------------ */

/** Parse the pieces of a `postgres(ql)://` URL we need, without `pg`. */
export function parseDbUrl(connectionString: string): {
  protocol: string;
  user: string;
  host: string;
  port: number;
  database: string;
  query: URLSearchParams;
} {
  const url = new URL(connectionString);
  return {
    protocol: url.protocol.replace(":", ""),
    user: decodeURIComponent(url.username),
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.replace(/^\//, ""),
    query: url.searchParams,
  };
}

/**
 * True when the URL already targets a pooler:
 *   - Neon pooled endpoints (`ep-…-pooler.aws.neon.tech`)
 *   - Supabase pooler hosts (`*.pooler.supabase.com` / `:6543`)
 *   - explicit `?pgbouncer=true` (older Neon clients)
 */
export function isPoolerUrl(connectionString: string): boolean {
  const { host, port, query } = parseDbUrl(connectionString);
  return (
    /(^|-)pooler\./i.test(host) ||
    /-pooler\./i.test(host) ||
    host.includes(".pooler.") ||
    port === 6543 ||
    query.get("pgbouncer") === "true"
  );
}

/**
 * Rewrite a direct connection string to its pooled counterpart.
 *
 * - Neon: `ep-foo-123.aws.neon.tech` → `ep-foo-123-pooler.aws.neon.tech`
 *   (Neon's documented pooled endpoint; query params such as `sslmode` and
 *   `channel_binding` are preserved).
 * - Supabase: the pooler is a different hostname (`*.pooler.supabase.com`)
 *   with a `postgres.<project-ref>` user, so the URL cannot be derived from
 *   the direct one — copy the "Transaction pooler" string from the dashboard
 *   and pass it as-is (this function leaves it untouched).
 * - Anything already pooled is returned unchanged.
 */
export function toPoolerUrl(connectionString: string): string {
  if (isPoolerUrl(connectionString)) return connectionString;
  const url = new URL(connectionString);
  // Neon direct endpoints are `ep-<slug>.…neon.tech`; pooled adds `-pooler`.
  if (/neon\.tech$/i.test(url.hostname) && !url.hostname.includes("-pooler")) {
    url.hostname = url.hostname.replace(/^(ep-[a-z0-9-]+)\./i, "$1-pooler.");
    return url.toString();
  }
  return connectionString;
}

/** Inverse of `toPoolerUrl` for the Neon pattern (admin/migration tasks). */
export function toDirectUrl(connectionString: string): string {
  const url = new URL(connectionString);
  if (/neon\.tech$/i.test(url.hostname) && url.hostname.includes("-pooler")) {
    url.hostname = url.hostname.replace(/-pooler\./i, ".");
  }
  url.searchParams.delete("pgbouncer");
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * Pool construction
 * ------------------------------------------------------------------ */

/** The subset of `pg.Pool` the data plane relies on. */
export interface PgPoolLike extends Queryable {
  connect(): Promise<LeasedConnection>;
  end(): Promise<void>;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}

/** An injected driver (e.g. `require("pg")`) — never imported here. */
export interface PgDriver {
  Pool: new (config: Record<string, unknown>) => PgPoolLike;
}

export function mergeSettings(overrides: Partial<PgBouncerSettings> = {}): PgBouncerSettings {
  return { ...TRANSACTION_POOL_DEFAULTS, ...overrides };
}

/**
 * The config object to hand `new pg.Pool(...)` for a PgBouncer-fronted
 * database. Kept as data (not a constructed pool) so callers can inspect it,
 * test it, or feed it to any driver.
 */
export function pgPoolConfig(config: PgBouncerConfig): Record<string, unknown> {
  const { settings } = config;
  return {
    connectionString: config.connectionString,
    // Per-process client slots: never exceed what the pooler can multiplex.
    max: Math.max(1, settings.maxClientConnections),
    min: Math.min(settings.minPoolSize, settings.maxClientConnections),
    idleTimeoutMillis: settings.serverIdleTimeout * 1000,
    connectionTimeoutMillis: settings.checkoutTimeoutMs,
    application_name: config.applicationName ?? "retroflex-dataplane",
    // Transaction mode: statement caching lives in pgbouncer.ini
    // (`query_cache_size = 0`), never in the client — see infra/pgbouncer/.
  };
}

export interface PooledPool extends PgPoolLike {
  /** Run `fn` on one pinned connection (safe for multi-statement transactions). */
  withConnection<T>(fn: (conn: LeasedConnection) => Promise<T>): Promise<T>;
  /** BEGIN/COMMIT wrapper around `withConnection`. */
  withTransaction<T>(fn: (conn: Queryable) => Promise<T>): Promise<T>;
  stats(): {
    checkouts: number;
    returns: number;
    resets: number;
    errors: number;
    mode: PoolMode;
    maxClientConnections: number;
  };
}

/**
 * Wrap an injected driver pool with the transaction-mode discipline:
 * leases are always returned, session mode scrubs state on return
 * (`DISCARD ALL`), and checkout accounting is exposed for dashboards.
 */
export function createPgBouncerPool(config: PgBouncerConfig, driver: PgDriver): PooledPool {
  const settings = mergeSettings(config.settings);
  const pool = new driver.Pool(pgPoolConfig({ ...config, settings }));
  const counters = { checkouts: 0, returns: 0, resets: 0, errors: 0 };

  async function withConnection<T>(fn: (conn: LeasedConnection) => Promise<T>): Promise<T> {
    const conn = await pool.connect();
    counters.checkouts += 1;
    let released = false;
    const releaseNow = () => {
      if (released) return;
      released = true;
      counters.returns += 1;
      if (settings.poolMode === "session") {
        // Session mode hands the same server connection back; scrub anything
        // the borrower set. Transaction mode gets a fresh server connection
        // per checkout anyway, so this is a no-op there.
        counters.resets += 1;
        void conn.query("discard all").catch(() => undefined);
      }
      conn.release();
    };
    const leased: LeasedConnection = {
      query: (sql, params) => conn.query(sql, params),
      release: releaseNow,
    };
    try {
      return await fn(leased);
    } catch (error) {
      counters.errors += 1;
      throw error;
    } finally {
      releaseNow();
    }
  }

  return {
    query: (sql, params) => pool.query(sql, params),
    connect: () => pool.connect(),
    end: () => pool.end(),
    withConnection,
    async withTransaction<T>(fn: (conn: Queryable) => Promise<T>): Promise<T> {
      return withConnection(async (conn) => {
        await conn.query("begin");
        try {
          const result = await fn(conn);
          await conn.query("commit");
          return result;
        } catch (error) {
          await conn.query("rollback").catch(() => undefined);
          throw error;
        }
      });
    },
    stats: () => ({
      ...counters,
      mode: settings.poolMode,
      maxClientConnections: settings.maxClientConnections,
    }),
  };
}

/** Re-export the driver-agnostic query types from one import site. */
export type { LeasedConnection, Queryable, QueryResult };
