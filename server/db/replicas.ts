/**
 * Read/write splitting across the primary and read replicas.
 *
 * The app is read-dominated: every display polls campaigns, every console
 * lists events and terminals. Sending those reads to the primary is what
 * produced "too many reads". The router fixes the topology:
 *
 *   write ──▶ primary (through PgBouncer)          ──▶ invalidate cache keys
 *   read  ──▶ memcached ──▶ healthy replica (round-robin)
 *                              └── all down? ──▶ primary (correctness first)
 *
 * Failure handling:
 *   - A replica that errors is quarantined for `cooldownMs`, then probed again.
 *   - Reads fall back to the primary rather than failing — a stale-ish
 *     replica is an availability problem, not a correctness one.
 *   - `strongConsistency` reads (e.g. right after a write in the same
 *     request) skip replicas and can skip the cache too.
 */

import type { Queryable, QueryEvent, QueryResult } from "./types";

export interface ReadRouterOptions {
  /** Write target — typically the PgBouncer-fronted primary. */
  primary: Queryable;
  /** Read replicas. Omit to send reads to the primary (degenerate but valid). */
  replicas?: Queryable[];
  /** Optional memcached read-through cache; see server/cache/memcached.ts. */
  cache?: ReadRouterCache;
  /** How long a failed replica stays quarantined before a probe read. */
  cooldownMs?: number;
  clock?: () => number;
  onEvent?: (event: QueryEvent) => void;
}

/** The slice of ReadThroughCache the router uses (structural — no hard import). */
export interface ReadRouterCache {
  getOrLoad<T>(key: string, loader: () => Promise<T>, ttlSeconds?: number): Promise<{ value: T; hit: boolean }>;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  bump(key: string, by?: number): Promise<number>;
  invalidate(...keys: string[]): Promise<void>;
}

export interface ReadOptions {
  /** Cache key — presence enables cache-aside for this read. */
  cacheKey?: string;
  ttlSeconds?: number;
  /** Skip the cache even when `cacheKey` is set (freshness-sensitive views). */
  bypassCache?: boolean;
  /** Route to the primary even though the statement is a read. */
  strongConsistency?: boolean;
}

export interface WriteOptions {
  /** Cache keys to invalidate after the write commits. */
  cacheKeys?: string[];
  /** Generation counters to bump after the write (re-keys derived lists). */
  bumpKeys?: string[];
}

export interface ReadRouterStats {
  reads: number;
  writes: number;
  cacheHits: number;
  replicaServed: number;
  primaryServed: number;
  replicaFailures: number;
  quarantined: number;
}

export interface ReadRouter {
  read<R = Record<string, unknown>>(sql: string, params?: readonly unknown[], options?: ReadOptions): Promise<QueryResult<R>>;
  write<R = Record<string, unknown>>(sql: string, params?: readonly unknown[], options?: WriteOptions): Promise<QueryResult<R>>;
  stats(): ReadRouterStats;
  /** Replicas currently out of quarantine. */
  healthyReplicas(): number;
  /** The cache in front of reads, when one was configured. */
  readonly cache?: ReadRouterCache;
}

interface ReplicaState {
  target: Queryable;
  quarantinedUntil: number;
  failures: number;
}

export function createReadRouter(options: ReadRouterOptions): ReadRouter {
  const { primary, cache, onEvent } = options;
  const clock = options.clock ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 30_000;

  const replicas: ReplicaState[] = (options.replicas ?? []).map((target) => ({
    target,
    quarantinedUntil: 0,
    failures: 0,
  }));

  const stats: ReadRouterStats = {
    reads: 0,
    writes: 0,
    cacheHits: 0,
    replicaServed: 0,
    primaryServed: 0,
    replicaFailures: 0,
    quarantined: 0,
  };

  let cursor = 0;
  const emit = (kind: QueryEvent["kind"], detail: string) => onEvent?.({ kind, detail });

  function nextHealthyReplica(): ReplicaState | null {
    if (replicas.length === 0) return null;
    const now = clock();
    for (let i = 0; i < replicas.length; i += 1) {
      const state = replicas[(cursor + i) % replicas.length];
      if (state.quarantinedUntil <= now) {
        cursor = (cursor + i + 1) % replicas.length;
        return state;
      }
    }
    return null;
  }

  async function runOnReplica<R>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
    for (;;) {
      const state = nextHealthyReplica();
      if (!state) break;
      try {
        const result = await state.target.query<R>(sql, params);
        stats.replicaServed += 1;
        return result;
      } catch (error) {
        state.failures += 1;
        state.quarantinedUntil = clock() + cooldownMs;
        stats.replicaFailures += 1;
        stats.quarantined += 1;
        emit("replica-error", error instanceof Error ? error.message : String(error));
      }
    }
    // Every replica is down or unconfigured: fall back to the primary so the
    // read still succeeds. Availability beats topology purity.
    emit("replica-fallback", "read fell back to primary");
    stats.primaryServed += 1;
    return primary.query<R>(sql, params);
  }

  return {
    async read<R = Record<string, unknown>>(sql: string, params?: readonly unknown[], readOptions: ReadOptions = {}): Promise<QueryResult<R>> {
      stats.reads += 1;

      const load = (): Promise<QueryResult<R>> => {
        if (readOptions.strongConsistency || replicas.length === 0) {
          stats.primaryServed += 1;
          emit("read", "primary (strong consistency)");
          return primary.query<R>(sql, params);
        }
        emit("read", "replica");
        return runOnReplica<R>(sql, params);
      };

      if (!cache || !readOptions.cacheKey || readOptions.bypassCache) {
        return load();
      }

      const { value, hit } = await cache.getOrLoad<QueryResult<R>>(
        readOptions.cacheKey,
        load,
        readOptions.ttlSeconds,
      );
      if (hit) {
        stats.cacheHits += 1;
        emit("cache-hit", readOptions.cacheKey);
      } else {
        emit("cache-miss", readOptions.cacheKey);
      }
      return value;
    },

    async write<R = Record<string, unknown>>(sql: string, params?: readonly unknown[], writeOptions: WriteOptions = {}): Promise<QueryResult<R>> {
      stats.writes += 1;
      emit("write", "primary");
      const result = await primary.query<R>(sql, params);
      if (cache) {
        if (writeOptions.cacheKeys && writeOptions.cacheKeys.length > 0) {
          await cache.invalidate(...writeOptions.cacheKeys);
        }
        if (writeOptions.bumpKeys && writeOptions.bumpKeys.length > 0) {
          await Promise.all(writeOptions.bumpKeys.map((key) => cache.bump(key)));
        }
      }
      return result;
    },

    stats: () => ({ ...stats, quarantined: replicas.filter((r) => r.quarantinedUntil > clock()).length }),
    healthyReplicas: () => replicas.filter((r) => r.quarantinedUntil <= clock()).length,
    cache,
  };
}
