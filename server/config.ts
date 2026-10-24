/**
 * Environment → data-plane wiring.
 *
 * Composes the three fixes for the production load profile:
 *
 *   1. PgBouncer in front of the Postgres primary (connection storms)
 *   2. Read replicas for the read-dominated queries ("too many reads")
 *   3. Memcached read-through caching in front of those replicas
 *
 * plus the image machine map for logical shard placement. Every piece is
 * injectable, so `createDataPlane` is exercised in tests with fakes and in
 * production with `pg` and a real memcached socket factory.
 *
 * All variables are plain process env (server-side only — never VITE_*, never
 * bundled into the browser). See INFRASTRUCTURE.md for the full reference.
 */

import type { PgBouncerConfig, PgBouncerSettings, PgDriver, PooledPool } from "./db/pgbouncer";
import { createPgBouncerPool, isPoolerUrl, mergeSettings, toPoolerUrl } from "./db/pgbouncer";
import type { Queryable } from "./db/types";
import type { ReadRouter } from "./db/replicas";
import { createReadRouter } from "./db/replicas";
import type { MemcachedClient, ReadThroughCache, SocketFactory } from "./cache/memcached";
import { createMemcachedClient, createReadThroughCache } from "./cache/memcached";
import type { RateLimiter } from "./limits/rateLimit";
import { createRateLimiter } from "./limits/rateLimit";
import type { CampaignStore } from "./db/campaignStore";
import { createCampaignStore } from "./db/campaignStore";
import type { ImagePlane } from "./images/machineMap";
import { createImagePlane, loadMachineMap } from "./images/machineMap";

export interface DataPlaneEnv {
  /** PgBouncer endpoint for writes (Neon `-pooler` URL, or self-hosted :6543). */
  DATABASE_URL?: string;
  /** Comma-separated read-replica URLs. Reads round-robin across them. */
  DATABASE_REPLICA_URLS?: string;
  /** Comma-separated `host:port` memcached servers. */
  MEMCACHED_URLS?: string;
  /** Path to the image machine-map JSON (infra/image-machines.example.json). */
  IMAGE_MACHINE_MAP?: string;
  /** transaction | session | statement — default transaction. */
  PG_POOL_MODE?: string;
  PG_DEFAULT_POOL_SIZE?: string;
  PG_MIN_POOL_SIZE?: string;
  PG_MAX_CLIENT_CONNECTIONS?: string;
  PG_CHECKOUT_TIMEOUT_MS?: string;
  MEMCACHED_DEFAULT_TTL_SECONDS?: string;
  RATE_LIMIT_MAX_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  [key: string]: string | undefined;
}

export interface DataPlaneConfig {
  primary: PgBouncerConfig;
  replicaUrls: string[];
  memcachedServers: string[];
  memcachedDefaultTtlSeconds: number;
  rateLimitMaxRequests: number;
  rateLimitWindowSeconds: number;
  machineMapPath?: string;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readDataPlaneConfig(env: DataPlaneEnv): DataPlaneConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATA PLANE: DATABASE_URL is required (point it at PgBouncer, not the raw primary)");
  }

  const mode = (env.PG_POOL_MODE ?? "transaction") as PgBouncerSettings["poolMode"];
  const settings = mergeSettings({
    poolMode: mode,
    defaultPoolSize: int(env.PG_DEFAULT_POOL_SIZE, mergeSettings().defaultPoolSize),
    minPoolSize: int(env.PG_MIN_POOL_SIZE, mergeSettings().minPoolSize),
    maxClientConnections: int(env.PG_MAX_CLIENT_CONNECTIONS, mergeSettings().maxClientConnections),
    checkoutTimeoutMs: int(env.PG_CHECKOUT_TIMEOUT_MS, mergeSettings().checkoutTimeoutMs),
  });

  return {
    primary: {
      // Safety net: a direct Neon URL is silently rewritten to its `-pooler`
      // twin so the app never opens raw connections against the primary.
      connectionString: toPoolerUrl(databaseUrl),
      settings,
      applicationName: "retroflex-dataplane",
    },
    replicaUrls: (env.DATABASE_REPLICA_URLS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    memcachedServers: (env.MEMCACHED_URLS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    memcachedDefaultTtlSeconds: int(env.MEMCACHED_DEFAULT_TTL_SECONDS, 60),
    rateLimitMaxRequests: Math.max(1, int(env.RATE_LIMIT_MAX_REQUESTS, 120)),
    rateLimitWindowSeconds: Math.max(1, int(env.RATE_LIMIT_WINDOW_SECONDS, 60)),
    machineMapPath: env.IMAGE_MACHINE_MAP,
  };
}

export interface DataPlaneDeps {
  /** Injected `pg` (or compatible) module. */
  driver: PgDriver;
  /** Socket factory for memcached; defaults to one built on `node:net`. */
  socketFactory?: SocketFactory;
  /** Pre-built replicas (tests); otherwise built from `driver` + config URLs. */
  replicas?: Queryable[];
  /** Pre-built cache (tests); otherwise built from config memcached servers. */
  cache?: ReadThroughCache | null;
  /** Complete snapshot only: enables a safe Bloom prefilter for campaign.get(). */
  knownCampaignIds?: Iterable<string>;
  /** Optional injected limiter (tests/custom backends). */
  rateLimiter?: RateLimiter;
}

export interface DataPlane {
  /** Write pool: PgBouncer → primary, with lease/transaction discipline. */
  primaryPool: PooledPool;
  /** Cache → replica → primary read/write router. */
  router: ReadRouter;
  /** Campaign reads/writes with generation-stamped list caching. */
  campaigns: CampaignStore;
  /** Apply before DB-backed request handlers; shared when memcached is configured. */
  rateLimiter: RateLimiter;
  /** Image logical shards → machine map placements. */
  images?: ImagePlane;
  cache: ReadThroughCache;
  memcached?: MemcachedClient;
  config: DataPlaneConfig;
}

export function createDataPlane(env: DataPlaneEnv, deps: DataPlaneDeps): DataPlane {
  const config = readDataPlaneConfig(env);

  const primaryPool = createPgBouncerPool(config.primary, deps.driver);

  let memcached: MemcachedClient | undefined;
  let cache: ReadThroughCache | null = deps.cache ?? null;
  if (!cache && config.memcachedServers.length > 0 && deps.socketFactory) {
    memcached = createMemcachedClient({
      servers: config.memcachedServers,
      socketFactory: deps.socketFactory,
      defaultTtlSeconds: config.memcachedDefaultTtlSeconds,
    });
    cache = createReadThroughCache({
      client: memcached,
      defaultTtlSeconds: config.memcachedDefaultTtlSeconds,
    });
  }
  const effectiveCache = cache ?? createReadThroughCache({ client: null });

  const replicas: Queryable[] =
    deps.replicas ??
    config.replicaUrls.map((connectionString) => new deps.driver.Pool({ connectionString }));

  const router = createReadRouter({
    primary: primaryPool,
    replicas,
    cache: effectiveCache,
  });

  const campaigns = createCampaignStore({ router, knownCampaignIds: deps.knownCampaignIds });
  const rateLimiter = deps.rateLimiter ?? createRateLimiter({ client: memcached ?? null });

  const images = config.machineMapPath ? createImagePlane(loadMachineMap(config.machineMapPath)) : undefined;

  return { primaryPool, router, campaigns, rateLimiter, images, cache: effectiveCache, memcached, config };
}

export { isPoolerUrl, toPoolerUrl };
