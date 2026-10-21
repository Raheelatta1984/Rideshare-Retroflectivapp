/**
 * Campaign read path — where PgBouncer, replicas and memcached meet.
 *
 * `list()` is the hottest query in the product (every display polls it) and
 * was the bulk of the "too many reads" load on the primary. It now runs
 * cache → replica → primary through the read router, and every write bumps a
 * generation counter so all list variants re-key themselves (memcached cannot
 * delete by prefix, so exact-key invalidation of `campaigns:list:<since>:…`
 * variants would be a losing game — versioning the key space is the standard
 * fix and keeps old generations to expire on their TTL).
 *
 * SQL is the same shape the Supabase adapter speaks over REST
 * (supabase/migrations/0001_signage_phase2.sql), so this store is the
 * server-side twin of `src/lib/backend/supabase.ts` for deployments that
 * hold a direct Postgres connection (Neon via PgBouncer, or self-hosted).
 */

import type { QueryResult } from "./types";
import type { ReadRouter } from "./replicas";

export interface CampaignRow {
  id: string;
  title: string;
  payload: unknown;
  approval_state: string;
  compliance_mode?: string | null;
  updated_at: string | Date;
}

export interface CampaignListQuery {
  /** Only rows changed since this Unix-ms timestamp (cheap polling). */
  since?: number;
  limit?: number;
}

export interface CampaignStore {
  list(query?: CampaignListQuery): Promise<CampaignRow[]>;
  get(id: string): Promise<CampaignRow | null>;
  upsert(row: Pick<CampaignRow, "id" | "title" | "payload" | "approval_state"> & { complianceMode?: string }): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface CampaignStoreOptions {
  router: ReadRouter;
  /** List-cache TTL in seconds (default 15s — displays poll roughly this fast). */
  listTtlSeconds?: number;
  clock?: () => number;
}

/** Version counter; bumped on every write, stamped into list cache keys. */
const LIST_GEN_KEY = "campaigns:list:gen";
const itemKeyFor = (id: string) => `campaigns:item:${id}`;

export function createCampaignStore(options: CampaignStoreOptions): CampaignStore {
  const { router } = options;
  const listTtl = options.listTtlSeconds ?? 15;
  const clock = options.clock ?? Date.now;
  const cache = router.cache;

  async function listKey(query: CampaignListQuery): Promise<string> {
    const gen = cache ? ((await cache.get<number>(LIST_GEN_KEY)) ?? 0) : 0;
    return `campaigns:list:g${gen}:${query.since ?? 0}:${query.limit ?? 500}`;
  }

  return {
    async list(query: CampaignListQuery = {}): Promise<CampaignRow[]> {
      const limit = query.limit ?? 500;
      const params: unknown[] = [];
      let where = "";
      if (query.since) {
        params.push(new Date(query.since).toISOString());
        where = "where updated_at > $1";
      }
      params.push(limit);
      const sql = `select id, title, payload, approval_state, compliance_mode, updated_at
        from campaigns ${where}
        order by updated_at desc
        limit $${params.length}`;

      const result = await router.read<CampaignRow>(sql, params, {
        cacheKey: await listKey({ since: query.since, limit }),
        ttlSeconds: listTtl,
      });
      return result.rows;
    },

    async get(id: string): Promise<CampaignRow | null> {
      const result = await router.read<CampaignRow>(
        "select id, title, payload, approval_state, compliance_mode, updated_at from campaigns where id = $1 limit 1",
        [id],
        { cacheKey: itemKeyFor(id), ttlSeconds: listTtl },
      );
      return result.rows[0] ?? null;
    },

    async upsert(row): Promise<void> {
      const params = [
        row.id,
        row.title,
        JSON.stringify(row.payload ?? {}),
        row.approval_state,
        row.complianceMode ?? null,
        new Date(clock()).toISOString(),
      ];
      await router.write(
        `insert into campaigns (id, title, payload, approval_state, compliance_mode, updated_at)
         values ($1, $2, $3::jsonb, $4, $5, $6)
         on conflict (id) do update set
           title = excluded.title,
           payload = excluded.payload,
           approval_state = excluded.approval_state,
           compliance_mode = excluded.compliance_mode,
           updated_at = excluded.updated_at`,
        params,
        // One generation bump re-keys every list variant; the item key is
        // deleted outright because single-key invalidation is exact.
        { cacheKeys: [itemKeyFor(row.id)], bumpKeys: [LIST_GEN_KEY] },
      );
    },

    async remove(id: string): Promise<void> {
      await router.write("delete from campaigns where id = $1", [id], {
        cacheKeys: [itemKeyFor(id)],
        bumpKeys: [LIST_GEN_KEY],
      });
    },
  };
}

/** Tiny helper so callers can wrap arbitrary reads with the same discipline. */
export function cachedQuery<R>(
  router: ReadRouter,
  sql: string,
  params: readonly unknown[],
  cacheKey: string,
  ttlSeconds?: number,
): Promise<QueryResult<R>> {
  return router.read<R>(sql, params, { cacheKey, ttlSeconds });
}
