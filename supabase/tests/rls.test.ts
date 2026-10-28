// @vitest-environment node
/**
 * RLS integration tests — the migrations are applied to a real PostgreSQL
 * (PGlite is Postgres 18 compiled to WebAssembly) and the policies are
 * exercised as `anon`, as two different signed-in drivers, and as a reviewer.
 *
 * This is what "the policies still need redesign" needs to be defended with:
 * assertions about what each role can actually read and write, not a reading of
 * the SQL. No Docker, no hosted project, so it runs in CI.
 *
 * The Supabase-shaped objects (`auth.users`, `auth.jwt()`, `storage.objects`,
 * the `supabase_realtime` publication) and their default grants live in
 * `./harness`, shared with the migration-ordering suite in
 * `./hardening.test.ts`, so the two can never drift apart.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  ALL_MIGRATIONS,
  anon,
  as as actAs,
  createTestDatabase,
  denied,
  driverA,
  driverB,
  campaignPayload as payload,
  reviewer,
  rows as readRows,
  seedOwned,
  type Actor,
} from "./harness";

const DRIVER_A = driverA.sub as string;
const DRIVER_B = driverB.sub as string;
const ADMIN = reviewer.sub as string;

let db: PGlite;

/** Thin wrappers so the assertions below read as `rows(sql)` / `as(actor, fn)`. */
function as<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
  return actAs(db, actor, fn);
}

function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return readRows<T>(db, sql, params);
}

beforeAll(async () => {
  const created = await createTestDatabase(ALL_MIGRATIONS);
  db = created.db;
  await seedOwned(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("anonymous access", () => {
  it("cannot read the campaigns table at all", async () => {
    const message = await denied(() => as(anon, () => rows("select * from public.campaigns")));
    expect(message).toMatch(/permission denied/i);
  });

  it("reads approved campaigns through the public projection, without consent PII", async () => {
    const list = await as(anon, () => rows<{ id: string; payload: Record<string, unknown> }>("select * from public.public_campaigns order by id"));
    expect(list.map((row) => row.id)).toEqual(["camp_approved"]);

    const legal = list[0].payload.legal as Record<string, Record<string, unknown>>;
    expect(legal.driver).toEqual({ confirmed: true, signerName: "on file", agreementReference: "on file" });
    expect(JSON.stringify(list[0].payload)).not.toContain("Priya Raman");
    expect(JSON.stringify(list[0].payload)).not.toContain("priya@example.com");
    expect(JSON.stringify(list[0].payload)).not.toContain("AGR-2026-001");
    // The terms the display needs survive the redaction.
    expect(legal.merchantName).toBe("Bondi Coffee");
  });

  it("cannot see drafts through the projection", async () => {
    const list = await as(anon, () => rows<{ id: string }>("select id from public.public_campaigns where id = 'camp_a_draft'"));
    expect(list).toHaveLength(0);
  });

  it("cannot read the audit trail, events or devices", async () => {
    expect(await denied(() => as(anon, () => rows("select * from public.approval_audit")))).toMatch(/permission denied/i);
    expect(await denied(() => as(anon, () => rows("select * from public.devices")))).toMatch(/permission denied/i);
    // 0005 grants INSERT on events but not SELECT.
    expect(await denied(() => as(anon, () => rows("select * from public.campaign_events")))).toMatch(/permission denied/i);
  });

  it("cannot read the booths table or the old directory view", async () => {
    expect(await denied(() => as(anon, () => rows("select * from public.booths")))).toMatch(/permission denied/i);
    const missing = await denied(() => as(anon, () => rows("select * from public.booth_directory")));
    expect(missing).toMatch(/does not exist|permission denied/i);
  });

  it("resolves a pair code to a position and nothing else", async () => {
    const result = await as(anon, () => rows<{ resolve_pair_code: Record<string, unknown> }>("select public.resolve_pair_code('ABC123')"));
    expect(result[0].resolve_pair_code).toEqual({ found: true, position: "rear" });

    const front = await as(anon, () => rows<{ resolve_pair_code: Record<string, unknown> }>("select public.resolve_pair_code('front1')"));
    expect(front[0].resolve_pair_code).toEqual({ found: true, position: "front" });

    const missing = await as(anon, () => rows<{ resolve_pair_code: Record<string, unknown> }>("select public.resolve_pair_code('ZZZZZZ')"));
    expect(missing[0].resolve_pair_code).toEqual({ found: false });
  });

  it("may report a play for an approved campaign", async () => {
    await as(anon, () =>
      rows(
        "insert into public.campaign_events (id, campaign_id, device_id, kind, at) values ('evt_anon_ok','camp_approved','dev-x','proof-of-play', now())",
      ),
    );
    const found = await db.query("select 1 from public.campaign_events where id = 'evt_anon_ok'");
    expect(found.rows).toHaveLength(1);
  });

  it("may not report a play for a draft campaign", async () => {
    const message = await denied(() =>
      as(anon, () =>
        rows(
          "insert into public.campaign_events (id, campaign_id, device_id, kind, at) values ('evt_anon_bad','camp_a_draft','dev-x','proof-of-play', now())",
        ),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it("may not backdate or future-date a play", async () => {
    const future = await denied(() =>
      as(anon, () =>
        rows(
          "insert into public.campaign_events (id, campaign_id, device_id, kind, at) values ('evt_future','camp_approved','dev-x','proof-of-play', now() + interval '30 days')",
        ),
      ),
    );
    expect(future).toMatch(/row-level security/i);
  });

  it("may not write a campaign", async () => {
    const message = await denied(() =>
      as(anon, () =>
        rows(
          `insert into public.campaigns (id, title, payload, approval_state, owner) values ('camp_anon','x','{}'::jsonb,'draft','${DRIVER_A}')`,
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe("signed-in drivers", () => {
  it("see their own rows plus approved campaigns only", async () => {
    const list = await as(driverB, () => rows<{ id: string }>("select id from public.campaigns order by id"));
    expect(list.map((row) => row.id)).toEqual(["camp_approved", "camp_b_draft"]);
    expect(list.map((row) => row.id)).not.toContain("camp_a_draft");
    expect(list.map((row) => row.id)).not.toContain("camp_a_pending");
  });

  it("still see the real consent records on rows they own", async () => {
    const own = await as(driverA, () => rows<{ payload: { legal: { driver: { signerName: string } } } }>("select payload from public.campaigns where id = 'camp_a_draft'"));
    expect(own[0].payload.legal.driver.signerName).toBe("Priya Raman");
  });

  it("cannot update another driver's campaign", async () => {
    const updated = await as(driverB, () => rows("update public.campaigns set title = 'hijacked' where id = 'camp_a_draft' returning id"));
    expect(updated).toHaveLength(0);
  });

  it("cannot delete another driver's campaign", async () => {
    const deleted = await as(driverB, () => rows("delete from public.campaigns where id = 'camp_a_draft' returning id"));
    expect(deleted).toHaveLength(0);
  });

  it("can create a draft for themselves but not for someone else", async () => {
    await as(driverA, () =>
      rows(
        `insert into public.campaigns (id, title, owner, approval_state, payload)
         values ('camp_a_new', 'New', '${DRIVER_A}', 'draft', '${JSON.stringify(payload("camp_a_new"))}'::jsonb)`,
      ),
    );
    const forged = await denied(() =>
      as(driverA, () =>
        rows(
          `insert into public.campaigns (id, title, owner, approval_state, payload)
           values ('camp_forged', 'Forged', '${DRIVER_B}', 'draft', '{}'::jsonb)`,
        ),
      ),
    );
    expect(forged).toMatch(/row-level security/i);
  });

  it("cannot approve or reject their own campaign", async () => {
    const approve = await denied(() =>
      as(driverA, () => rows("update public.campaigns set approval_state = 'approved' where id = 'camp_a_new' returning id")),
    );
    expect(approve).toMatch(/only a reviewer/i);

    const reject = await denied(() =>
      as(driverA, () => rows("update public.campaigns set approval_state = 'rejected' where id = 'camp_a_new' returning id")),
    );
    expect(reject).toMatch(/only a reviewer/i);
  });

  it("owns a row it inserts even without sending an owner", async () => {
    const inserted = await as(driverB, () =>
      rows<{ owner: string }>(
        `insert into public.campaigns (id, title, approval_state, payload)
         values ('camp_b_auto', 'Auto owner', 'draft', '{}'::jsonb) returning owner`,
      ),
    );
    expect(inserted[0].owner).toBe(DRIVER_B);
  });

  it("can move their own campaign to pending", async () => {
    const updated = await as(driverA, () =>
      rows("update public.campaigns set approval_state = 'pending' where id = 'camp_a_new' returning id"),
    );
    expect(updated).toHaveLength(1);
  });

  it("cannot edit an approved campaign at all", async () => {
    const message = await denied(() =>
      as(driverA, () => rows("update public.campaigns set title = 'swapped copy' where id = 'camp_approved' returning id")),
    );
    expect(message).toMatch(/read-only/i);
  });

  it("cannot self-insert an already-approved row", async () => {
    const message = await denied(() =>
      as(driverA, () =>
        rows(
          `insert into public.campaigns (id, title, owner, approval_state, payload)
           values ('camp_self_approved', 'Self approved', '${DRIVER_A}', 'approved', '${JSON.stringify(payload("camp_self_approved"))}'::jsonb)`,
        ),
      ),
    );
    expect(message).toMatch(/only a reviewer/i);
  });

  it("only see their own devices", async () => {
    const list = await as(driverA, () => rows<{ id: string }>("select id from public.devices"));
    expect(list.map((row) => row.id)).toEqual(["term_a"]);
  });

  it("cannot bind a device to another account", async () => {
    const message = await denied(() =>
      as(driverA, () =>
        rows(
          `insert into public.devices (id, name, pair_code, position, owner) values ('term_forged','Forged','ABC123','rear','${DRIVER_B}')`,
        ),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it("cannot write audit rows", async () => {
    const message = await denied(() =>
      as(driverA, () =>
        rows(`insert into public.approval_audit (campaign_id, state, reviewer) values ('camp_a_new','approved','me')`),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it("cannot rebalance the id plane", async () => {
    const updated = await as(driverA, () => rows("update public.id_shards set machine = 'mine' returning shard_ref"));
    expect(updated).toHaveLength(0);
  });

  it("cannot read another driver's events", async () => {
    const list = await as(driverB, () => rows<{ id: string }>("select id from public.campaign_events"));
    expect(list.map((row) => row.id)).not.toContain("evt_seed");
  });
});

describe("reviewers", () => {
  it("can see every campaign", async () => {
    const list = await as(reviewer, () => rows<{ id: string }>("select id from public.campaigns order by id"));
    expect(list.map((row) => row.id)).toEqual(
      expect.arrayContaining(["camp_a_draft", "camp_a_new", "camp_b_draft", "camp_approved"]),
    );
  });

  it("can approve a pending campaign, and the database records the audit row", async () => {
    await as(reviewer, () => rows("update public.campaigns set approval_state = 'approved' where id = 'camp_a_new'"));

    const audit = await db.query<{ state: string; reviewer_id: string }>(
      "select state, reviewer_id from public.approval_audit where campaign_id = 'camp_a_new' order by reviewed_at desc limit 1",
    );
    expect(audit.rows[0]).toMatchObject({ state: "approved", reviewer_id: ADMIN });
  });

  it("can reopen an approved campaign for editing", async () => {
    const updated = await as(reviewer, () =>
      rows("update public.campaigns set approval_state = 'pending' where id = 'camp_a_new' returning id"),
    );
    expect(updated).toHaveLength(1);
  });

  it("can rebalance the id plane", async () => {
    await as(reviewer, () => rows("insert into public.id_shards (shard_ref, machine) values (7, 'm1') on conflict (shard_ref) do update set machine = 'm1'"));
    const [row] = await db.query<{ machine: string }>("select machine from public.id_shards where shard_ref = 7").then((r) => r.rows);
    expect(row.machine).toBe("m1");
  });

  it("can read the events for any campaign", async () => {
    const list = await as(reviewer, () => rows("select id from public.campaign_events"));
    expect(list.length).toBeGreaterThan(0);
  });
});

describe("proof-of-play rollup", () => {
  it("is not readable anonymously", async () => {
    expect(await denied(() => as(anon, () => rows("select * from public.campaign_play_counts")))).toMatch(/permission denied/i);
  });

  it("counts only the events the caller may read", async () => {
    const own = await as(driverA, () => rows<{ campaign_id: string }>("select campaign_id from public.campaign_play_counts"));
    expect(own.map((row) => row.campaign_id)).toContain("camp_approved");

    const other = await as(driverB, () => rows<{ campaign_id: string }>("select campaign_id from public.campaign_play_counts"));
    expect(other.map((row) => row.campaign_id)).not.toContain("camp_approved");
  });
});

describe("storage policies", () => {
  it("scope writes to the campaign a caller owns", async () => {
    const owned = await as(driverA, () =>
      rows("insert into storage.objects (bucket_id, name) values ('campaigns','shard-0001/camp_a_draft/poster.png') returning id"),
    );
    expect(owned).toHaveLength(1);

    const stolen = await denied(() =>
      as(driverA, () =>
        rows("insert into storage.objects (bucket_id, name) values ('campaigns','shard-0001/camp_b_draft/poster.png') returning id"),
      ),
    );
    expect(stolen).toMatch(/row-level security/i);
  });

  it("lets anonymous readers fetch an approved campaign's asset and not a draft's", async () => {
    await db.query("insert into storage.objects (bucket_id, name) values ('campaigns','shard-0002/camp_approved/ad.png')");
    const readable = await as(anon, () => rows("select id from storage.objects where name like '%camp_approved%'"));
    expect(readable).toHaveLength(1);
    const draft = await as(anon, () => rows("select id from storage.objects where name like '%camp_a_draft%'"));
    expect(draft).toHaveLength(0);
  });
});
