# Infrastructure — PgBouncer, read replicas, memcached, image shards, next_id

This document covers the server-side data plane added for the Postgres
database: connection pooling, read scaling, caching, image placement and
clash-proof IDs. The browser app is unchanged in character — it still runs
the on-device adapter or talks to Supabase over REST (see `PHASE-2.md`).

## Contents

| Question | Answer |
| --- | --- |
| [Is Neon the database? Is PgBouncer implemented?](#1-neon--pgbouncer) | The backend is Supabase Postgres (and/or Neon) — **PgBouncer is implemented** for it |
| [Too many reads](#2-read-replicas--memcached-fixing-too-many-reads) | Read replicas + memcached read-through cache in front of them |
| [Image storage](#3-image-logical-shards--machine-map) | 13-bit logical shards + a rebalanceable machine map |
| [ID clashes](#4-next_id--64-bit-sortable-ids) | `next_id()`: 41-bit time \| 13-bit shard \| 10-bit counter |

---

## 1. Neon + PgBouncer

**Was Neon implemented as the database?** Not as the primary choice: the
Phase 2 commercial backend is Supabase Postgres over REST, with the on-device
local adapter as the default (README "No database" referred to the browser
app). The database story is now explicit:

- **Neon** and **Supabase** are both plain Postgres. The data plane
  (`server/`) speaks the wire protocol through an injected driver (`pg`,
  `postgres.js`, or Neon's serverless driver) and works with either.
- **PgBouncer is implemented** in `server/db/pgbouncer.ts`:
  - `toPoolerUrl()` rewrites a Neon direct endpoint
    (`ep-….aws.neon.tech`) to its hosted pooled twin
    (`ep-…-pooler.aws.neon.tech`) so the app can never accidentally open raw
    connections against the primary. `isPoolerUrl()` detects Supabase pooler
    URLs (`*.pooler.supabase.com`, `:6543`) and passes them through.
  - `createPgBouncerPool()` wraps the driver pool with transaction-mode
    discipline: leases always return, `withTransaction()` pins one connection
    across BEGIN/COMMIT, session mode scrubs state (`DISCARD ALL`) on return,
    and named prepared statements are never used.
  - `pgPoolConfig()` derives per-process client slots from the pooler's
    `default_pool_size`, so deploys cannot oversubscribe the pooler.
- **Self-hosted**: `infra/pgbouncer/pgbouncer.ini` is a production-shaped
  PgBouncer config in **transaction pooling** mode (`query_cache_size = 0`,
  `ignore_startup_parameters` for node-pg/Prisma startup packets).
  `infra/docker-compose.yml` runs postgres + pgbouncer + memcached locally.

Transaction-mode rules (encoded in the code, not just comments): no `SET`,
temp tables, `LISTEN`, or session advisory locks across checkouts; use
`withConnection`/`withTransaction` for anything multi-statement.

## 2. Read replicas + memcached (fixing "too many reads")

The app is read-dominated — every display polls campaigns, every console
lists events and terminals. Two changes fix that:

**Read replicas** (`server/db/replicas.ts`):

```
write ──▶ primary (through PgBouncer) ──▶ invalidate / bump cache keys
read  ──▶ memcached hit? ──▶ done
            │ miss
            ▼
         healthy replica (round-robin) ──▶ populate cache
            └─ all replicas down? ──▶ primary (availability first)
```

- Replicas are quarantined for 30s after an error, then probed again.
- `strongConsistency` reads (e.g. immediately after a write) pin to the
  primary; `bypassCache` skips the cache for freshness-sensitive views.
- Stats (`router.stats()`) expose cache hits, replica vs primary service,
  and failures for dashboards.

**Memcached** (`server/cache/memcached.ts`):

- A dependency-free text-protocol client (get/set/add/replace/delete/touch/
  incr/version) over an injectable socket — works against real memcached via
  `node:net`, or the in-memory implementation in tests.
- `createReadThroughCache()` adds JSON codec, TTLs, **single-flight** loading
  (a cold key under load triggers one database load, not one per request),
  and `bump()` for generation-stamped key spaces.
- Campaign `get(id)` negative-caches empty query results for 30s (configurable
  with `negativeTtlSeconds`); upsert/remove invalidates the item key. This
  prevents repeated lookups for the same absent ID from hitting Postgres.
- `server/cache/bloom.ts` provides a Bloom prefilter for an **optional complete
  campaign-ID snapshot**. When supplied at data-plane startup, a definite
  absent-ID result skips both cache and database; false positives merely fall
  through to the normal lookup. Do not seed it from paginated/limited data.
  Use it only when campaign IDs are exhaustive and all mutations go through
  this store: upserts add IDs, while deletes leave safe false positives until
  restart/reseed. External inserts require rebuilding the snapshot first.
- `plane.rateLimiter.check(clientKey, limit, windowSeconds)` is an atomic,
  shared fixed-window guard backed by memcached (`add`/`incr`), with a bounded
  per-process fallback. Apply it in the HTTP/API handler before invoking DB
  reads or writes; the current repository has no HTTP request server/middleware
  to attach this automatically. Defaults are 120 requests per 60 seconds and
  can be overridden with `RATE_LIMIT_MAX_REQUESTS` and
  `RATE_LIMIT_WINDOW_SECONDS`. Derive `clientKey` from a trusted auth subject
  or trusted proxy IP, never an arbitrary client-supplied header.
- Writes bump `campaigns:list:gen` instead of trying to delete every list
  variant (memcached cannot delete by prefix): the next poll re-keys and
  re-loads once. `server/db/campaignStore.ts` is the worked example — 25
  polls hit the database once (regression-tested).

## 3. Image logical shards + machine map

Images hash into a **fixed 13-bit logical shard space** (0‥8191 — the same
reference space as `next_id`'s shard field) and a **machine map** decides
which machine owns each shard (`src/lib/backend/imageShards.ts`):

```
key ──fnv1a32 (UTF-8)──▶ logical shard ──machine map──▶ machine + base URL
```

- **Logical shards never move.** `logicalShardFor("cmp_1/hero.png")` is a
  pure hash, identical in TypeScript and in SQL (`public.fnv1a32`,
  `public.logical_shard_for` — migration 0004), so a key's shard is stable
  for life on both sides of the wire.
- **The machine map is the only thing a rebalance touches.** Moving shards
  from `img-a` to `img-c` is an edit to the map (and an UPDATE on
  `image_shards`) — objects are not rehashed or renamed. `validateMachineMap()`
  fails loudly on gaps or double-ownership, so a bad map cannot split-brain.
- **Object paths embed the shard directory** — `shard-0042/<campaign>/<file>`
  — so relocating a shard moves whole directories. The Supabase adapter
  (`assets.put`) writes new uploads to this layout; existing assets keep
  their stored paths and keep resolving.
- Maps live as JSON (`infra/image-machines.example.json`) for the data plane
  and in `image_machines`/`image_shards` tables for SQL-side resolution
  (`public.image_machine_for(key)`).

## 4. next_id — 64-bit sortable IDs

For ID clashes: every minted ID is a 64-bit value in three parts
(`src/lib/nextId.ts`, `public.next_id()` in migration 0004):

```
┌────────────── 41 bits ──────────────┬── 13 bits ──┬── 10 bits ──┐
│  ms since 2026-01-01T00:00:00Z      │ shard ref   │ counter     │
└─────────────────────────────────────┴─────────────┴─────────────┘
  bits 63‥23                           bits 22‥10    bits 9‥0
```

- **41-bit timestamp** (~69.7 years from the 2026 epoch): IDs sort by mint
  time — numerically as `bigint`, and lexicographically as the 20-digit
  zero-padded decimal string `uid()` now emits.
- **13-bit shard reference** (0‥8191): names the minting generator/machine
  (registered in `id_shards`), so two machines can mint in the same
  millisecond without colliding.
- **10-bit counter** (0‥1023): serialises IDs minted in the same millisecond
  on one shard. Past 1024/ms the clock rolls forward 1 ms — monotonic,
  never blocking, never reusing a value. Clock steps backwards are absorbed
  the same way.
- The SQL `next_id(shard)` locks the shard row while minting, so concurrent
  database writers are clash-proof by construction; `next_id_timestamp_ms`,
  `next_id_shard`, `next_id_counter` decompose a value in SQL as `parseId()`
  does in TypeScript.
- `uid("drv")` etc. (`src/lib/id.ts`) now use this generator — the old
  base36-timestamp-plus-random format could collide within a millisecond.

## Wiring it up

Server-side env (full reference in `.env.example`):

```
DATABASE_URL=postgres://…-pooler.aws.neon.tech/…   # via PgBouncer
DATABASE_REPLICA_URLS=postgres://replica-a/…,postgres://replica-b/…
MEMCACHED_URLS=127.0.0.1:11211
IMAGE_MACHINE_MAP=infra/image-machines.json
```

```ts
import { createDataPlane, withRateLimit } from "./server";
import pg from "pg";

const plane = createDataPlane(process.env, {
  driver: pg,
  socketFactory: netSocketFactory,
  knownCampaignIds: fullCampaignIdSnapshot, // only a complete, authoritative snapshot
});
plane.campaigns.list();          // cache → replica → primary
plane.campaigns.upsert(row);     // primary → bump list generation
const route = withRateLimit(handleRequest, {
  limiter: plane.rateLimiter,
  limit: plane.config.rateLimitMaxRequests,
  windowSeconds: plane.config.rateLimitWindowSeconds,
  identifier: trustedClientKey, // authenticated ID or proxy-validated IP
}); // rejects with HTTP 429 before DB-backed handler work
plane.images?.place("cmp_1/hero.png"); // shard → machine → URL
```

Local stack: `docker compose -f infra/docker-compose.yml up` (postgres on
:5432, PgBouncer on :6543, memcached on :11211, migrations auto-applied).

## Tests

All green under `npm run verify` (typecheck · 326 unit tests · build · smoke):

- `src/lib/nextId.test.ts` — layout, sortability, counter roll, clock rollback
- `src/lib/backend/imageShards.test.ts` — hash vectors, map validation,
  rebalance keeps shards stable, path sanitising
- `server/db/pgbouncer.test.ts` — URL rewriting, pool config, lease/transaction
  discipline, session scrubbing
- `server/db/replicas.test.ts` — routing, round-robin, quarantine + failover,
  cache-aside, generation bumps
- `server/cache/memcached.test.ts` — text-protocol framing, pipelining,
  stampede protection, in-memory client
- `server/db/campaignStore.test.ts` — 25 polls → 1 database read; writes
  re-key the list cache
