/**
 * Distributed fixed-window request limiting backed by atomic memcached counters.
 *
 * If memcached is absent/unavailable this falls back to a bounded per-process
 * counter (availability-first). Deployments that need enforcement across
 * instances should configure shared memcached and apply `check()` before any
 * request path that can reach the database.
 */
import type { MemcachedClient } from "../cache/memcached";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix epoch milliseconds when this window resets. */
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

export interface RateLimiterOptions {
  client?: MemcachedClient | null;
  namespace?: string;
  clock?: () => number;
  /** Bound fallback state when the shared cache is unavailable. */
  maxLocalKeys?: number;
}

function hash(value: string): string {
  let code = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    code ^= value.charCodeAt(i);
    code = Math.imul(code, 0x01000193) >>> 0;
  }
  return code.toString(36);
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const client = options.client ?? null;
  const namespace = options.namespace ?? "rf:rl";
  const clock = options.clock ?? Date.now;
  const maxLocalKeys = Math.max(100, options.maxLocalKeys ?? 10_000);
  const local = new Map<string, { count: number; expiresAt: number }>();

  function localIncrement(key: string, expiresAt: number): number {
    // Sweep only under pressure; keep the fallback path cheap for normal traffic.
    if (local.size >= maxLocalKeys && !local.has(key)) {
      const now = clock();
      for (const [candidate, value] of local) {
        if (value.expiresAt <= now) local.delete(candidate);
      }
      if (local.size >= maxLocalKeys) {
        const oldest = local.keys().next().value as string | undefined;
        if (oldest) local.delete(oldest);
      }
    }
    const entry = local.get(key);
    if (entry && entry.expiresAt > clock()) {
      entry.count += 1;
      return entry.count;
    }
    local.set(key, { count: 1, expiresAt });
    return 1;
  }

  return {
    async check(identifier, limit, windowSeconds) {
      if (!identifier) throw new Error("rate-limit identifier must not be empty");
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("rate-limit limit must be a positive integer");
      if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error("rate-limit window must be positive");

      const now = clock();
      const windowMs = Math.max(1_000, Math.trunc(windowSeconds * 1_000));
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;
      const ttlSeconds = Math.max(1, Math.ceil((resetAt - now) / 1_000));
      const key = `${namespace}:${hash(identifier)}:${windowStart}`;
      let count: number;

      if (client) {
        try {
          // `add` creates the first count with the window TTL atomically.
          // A losing concurrent request increments the value already seeded.
          if (await client.add(key, "1", ttlSeconds)) {
            count = 1;
          } else {
            const incremented = await client.incr(key, 1);
            if (incremented !== null) {
              count = incremented;
            } else if (await client.add(key, "1", ttlSeconds)) {
              count = 1;
            } else {
              count = (await client.incr(key, 1)) ?? localIncrement(key, resetAt);
            }
          }
        } catch {
          count = localIncrement(key, resetAt);
        }
      } else {
        count = localIncrement(key, resetAt);
      }

      const allowed = count <= limit;
      return {
        allowed,
        limit,
        remaining: Math.max(0, limit - count),
        resetAt,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1_000)),
      };
    },
  };
}

/**
 * Fetch/Vercel-compatible request wrapper. Use a trusted identity key (e.g.
 * authenticated user ID or proxy-validated client IP) and wrap handlers that
 * can reach the database so rejected traffic never enters application work.
 */
export function withRateLimit<T extends Request>(
  handler: (request: T) => Response | Promise<Response>,
  options: {
    limiter: RateLimiter;
    limit: number;
    windowSeconds: number;
    identifier: (request: T) => string;
  },
): (request: T) => Promise<Response> {
  return async (request) => {
    const result = await options.limiter.check(
      options.identifier(request),
      options.limit,
      options.windowSeconds,
    );
    if (!result.allowed) {
      return new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(result.retryAfterSeconds),
          "RateLimit-Limit": String(result.limit),
          "RateLimit-Remaining": "0",
          "RateLimit-Reset": String(Math.ceil(result.resetAt / 1_000)),
        },
      });
    }
    const response = await handler(request);
    // Expose the standard quota metadata without mutating the handler's body.
    const headers = new Headers(response.headers);
    headers.set("RateLimit-Limit", String(result.limit));
    headers.set("RateLimit-Remaining", String(result.remaining));
    headers.set("RateLimit-Reset", String(Math.ceil(result.resetAt / 1_000)));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
