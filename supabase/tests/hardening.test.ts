// @vitest-environment node
/**
 * Migration ordering, atomicity and the reviewer grant.
 *
 * This is the deploy step itself, exercised against a real PostgreSQL:
 *
 *   1. start from the legacy state (0001–0004 applied, data present),
 *   2. apply 0005 + 0006 *together* through `scripts/db-hardening.mjs`,
 *   3. assert there is no window in which anonymous callers have no read path,
 *   4. assert a failure in 0006 rolls 0005 back too,
 *   5. grant the reviewer role, and assert it is what makes approvals possible.
 *
 * It exists because the ordering is a real hazard: 0005 revokes anonymous
 * privileges on `public.campaigns` and 0006 creates the only replacement. Run
 * one without the other and every display in the field shows an empty playlist.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  applyHardening,
  assignLegacyOwners,
  grantReviewer,
  listOwnerlessCampaigns,
  revokeUserSessions,
  verifyHardening,
} from "../../scripts/db-hardening.mjs";
import { HARDENING_MIGRATIONS, readMigration } from "../../scripts/db-hardening.mjs";
import {
  DRIVER_A,
  DRIVER_B,
  LEGACY_MIGRATIONS,
  anon,
  as,
  createTestDatabase,
  denied,
  driverA,
  reviewer,
  rows,
  seedLegacy,
  type TestDatabase,
} from "./harness";

let current: TestDatabase | null = null;

async function legacyDb(): Promise<TestDatabase> {
  current = await createTestDatabase(LEGACY_MIGRATIONS);
  await seedLegacy(current.db);
  return current;
}

afterEach(async () => {
  await current?.close();
  current = null;
});

describe("legacy state (0001–0004 only)", () => {
  it("lets anonymous callers read every draft, which is why 0005 exists", async () => {
    const { db } = await legacyDb();
    const list = await as(db, anon, () => rows<{ id: string }>(db, "select id from public.campaigns order by id"));
    // String order: "camp_a_" sorts before "camp_approved" ('_' < 'a').
    expect(list.map((row) => row.id)).toEqual(["camp_a_draft", "camp_a_pending", "camp_approved", "camp_b_draft"]);
  });

  it("exposes the enumerable booth directory", async () => {
    const { db } = await legacyDb();
    const directory = await as(db, anon, () => rows(db, "select owner, pair_code, front_pair_code from public.booth_directory"));
    expect(directory).toHaveLength(1);
    expect(directory[0].pair_code).toBe("ABC123");
  });
});

describe("applying 0005 + 0006 together", () => {
  it("leaves anonymous callers with a working read path, with no gap", async () => {
    const { db } = await legacyDb();

    const result = await applyHardening(db);
    expect(result.applied).toEqual([...HARDENING_MIGRATIONS]);
    expect(result.checks.every((check) => check.ok)).toBe(true);

    // The table is closed …
    expect(await denied(() => as(db, anon, () => rows(db, "select id from public.campaigns")))).toMatch(/permission denied/i);
    // … and the projection is open, in the same committed transaction.
    const visible = await as(db, anon, () => rows<{ id: string }>(db, "select id from public.public_campaigns"));
    expect(visible.map((row) => row.id)).toEqual(["camp_approved"]);
  });

  it("keeps the display's consent answer while removing the signer's identity", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);

    const [row] = await as(db, anon, () =>
      rows<{ payload: { legal: Record<string, Record<string, unknown>> } }>(db, "select payload from public.public_campaigns"),
    );
    expect(row.payload.legal.safetyAssessment).toEqual({
      confirmed: true,
      signerName: "on file",
      agreementReference: "on file",
    });
    expect(JSON.stringify(row.payload)).not.toContain("Priya Raman");
    expect(JSON.stringify(row.payload)).not.toContain("priya@example.com");
  });

  it("is idempotent — a second run succeeds", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    await expect(applyHardening(db)).resolves.toMatchObject({ applied: [...HARDENING_MIGRATIONS] });

    const visible = await as(db, anon, () => rows(db, "select id from public.public_campaigns"));
    expect(visible).toHaveLength(1);
  });

  it("rolls 0005 back when 0006 fails, instead of leaving no read path", async () => {
    const { db } = await legacyDb();
    const sql0005 = await readMigration(HARDENING_MIGRATIONS[0]);

    await expect(
      applyHardening(db, {
        migrations: [
          { name: HARDENING_MIGRATIONS[0], sql: sql0005 },
          { name: HARDENING_MIGRATIONS[1], sql: "create table public.half_applied (); select 1 / 0;" },
        ],
      }),
    ).rejects.toThrow(/0006_public_projections\.sql failed/);

    // Nothing from 0005 survived: the old behaviour is still intact, which is
    // recoverable, whereas a revoked-but-not-replaced read path is an outage.
    const list = await as(db, anon, () => rows<{ id: string }>(db, "select id from public.campaigns"));
    expect(list.length).toBe(4);
    expect(await rows(db, "select 1 from pg_class where relname = 'half_applied'")).toHaveLength(0);
    expect(await rows(db, "select 1 from pg_class where relname = 'public_campaigns'")).toHaveLength(0);
  });

  it("fails the deploy when a post-condition does not hold", async () => {
    const { db } = await legacyDb();
    const sql0005 = await readMigration(HARDENING_MIGRATIONS[0]);

    // 0005 without 0006 creates exactly the state the verification forbids.
    await expect(
      applyHardening(db, { migrations: [{ name: HARDENING_MIGRATIONS[0], sql: sql0005 }] }),
    ).rejects.toThrow(/verification failed/);

    const list = await as(db, anon, () => rows(db, "select id from public.campaigns"));
    expect(list.length).toBe(4);
  });

  it("reports every post-condition separately", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    const checks = await verifyHardening(db);
    expect(checks.map((check) => check.check)).toEqual(
      expect.arrayContaining([
        "public_campaigns projection exists",
        "legacy booth_directory view is gone",
        "anon cannot read campaigns",
        "anon can read the projection",
        "grant_admin is not callable by browser roles",
      ]),
    );
    expect(checks.filter((check) => !check.ok)).toEqual([]);
  });

  it("gives pre-existing rows to nobody, so only a reviewer can manage them", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);

    // Rows created before 0005 have no owner: their authors cannot claim them by
    // guessing, and the reviewer can still act.
    const [draft] = await rows<{ owner: string | null }>(db, "select owner from public.campaigns where id = 'camp_a_draft'");
    expect(draft.owner).toBeNull();

    const claimed = await as(db, driverA, () =>
      rows(db, "update public.campaigns set owner = auth.uid() where id = 'camp_a_draft' returning id"),
    );
    expect(claimed).toHaveLength(0);

    const opened = await as(db, reviewer, () =>
      rows(db, "update public.campaigns set owner = '11111111-1111-1111-1111-111111111111' where id = 'camp_a_draft' returning id"),
    );
    expect(opened).toHaveLength(1);
  });
});

describe("granting the reviewer role", () => {
  it("is refused for an address that does not exist, and says so", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);

    const result = await grantReviewer(db, "tic.raheel@gmail.com");
    expect(result).toMatchObject({ ok: false, reason: "no-such-user" });
    expect(result.message).toMatch(/Create or sign up that account first/);
  });

  it("sets app_metadata.role and is idempotent", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);

    const first = await grantReviewer(db, "a@example.com");
    expect(first).toMatchObject({ ok: true, role: "admin", userId: DRIVER_A });

    const second = await grantReviewer(db, "a@example.com");
    expect(second).toMatchObject({ ok: true, role: "admin" });

    const [user] = await rows<{ raw_app_meta_data: Record<string, unknown> }>(
      db,
      "select raw_app_meta_data from auth.users where id = $1",
      [DRIVER_A],
    );
    expect(user.raw_app_meta_data).toEqual({ role: "admin" });
  });

  it("makes the difference between a refused and an accepted approval", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);

    // Rows created before 0005 have no owner, so the deploy step assigns them
    // deliberately (docs/security/rls-model.md, "Existing rows with owner = null").
    await as(db, reviewer, async () => {
      await rows(db, "update public.campaigns set owner = $1 where id = 'camp_a_pending'", [DRIVER_A]);
      await rows(db, "update public.campaigns set owner = $1 where id = 'camp_b_draft'", [DRIVER_B]);
    });

    // Another driver's rows are invisible rather than forbidden: RLS filters,
    // it does not raise, so the statement succeeds and touches nothing.
    const invisible = await as(db, driverA, () =>
      rows(db, "update public.campaigns set approval_state = 'approved' where id = 'camp_b_draft' returning id"),
    );
    expect(invisible).toHaveLength(0);

    // A row A does own can be reached — and the reviewer trigger refuses it.
    const refused = await denied(() =>
      as(db, driverA, () => rows(db, "update public.campaigns set approval_state = 'approved' where id = 'camp_a_pending' returning id")),
    );
    expect(refused).toMatch(/only a reviewer/i);

    await grantReviewer(db, "a@example.com");

    // Now A's token carries app_metadata.role = admin, which is what the policy
    // reads — the grant alone changes nothing until the token is reissued.
    const granted: typeof driverA = { role: "authenticated", sub: DRIVER_A, appMetadata: { role: "admin" } };
    const approved = await as(db, granted, () =>
      rows(db, "update public.campaigns set approval_state = 'approved' where id = 'camp_a_pending' returning id"),
    );
    expect(approved).toHaveLength(1);

    // And the old token still cannot: the row is now approved, so the owner is
    // told to ask a reviewer. Signing in again is what changes this.
    const stale = await denied(() =>
      as(db, driverA, () => rows(db, "update public.campaigns set approval_state = 'pending' where id = 'camp_a_pending' returning id")),
    );
    expect(stale).toMatch(/read-only|only a reviewer/i);
  });

  it("records the reviewer on the audit row it triggers", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    await grantReviewer(db, "a@example.com");
    const granted = { role: "authenticated" as const, sub: DRIVER_A, appMetadata: { role: "admin" } };

    await as(db, granted, () => rows(db, "update public.campaigns set approval_state = 'pending' where id = 'camp_a_draft'"));

    const [audit] = await rows<{ state: string; reviewer_id: string }>(
      db,
      "select state, reviewer_id from public.approval_audit where campaign_id = 'camp_a_draft' order by reviewed_at desc limit 1",
    );
    expect(audit).toMatchObject({ state: "pending", reviewer_id: DRIVER_A });
  });

  it("cannot be run by the browser roles", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);

    for (const actor of [anon, driverA]) {
      const message = await denied(() => as(db, actor, () => rows(db, "select public.grant_admin('b@example.com')")));
      expect(message).toMatch(/permission denied/i);
    }

    const [user] = await rows<{ raw_app_meta_data: Record<string, unknown> }>(
      db,
      "select raw_app_meta_data from auth.users where id = $1",
      ["22222222-2222-2222-2222-222222222222"],
    );
    expect(user.raw_app_meta_data).toEqual({});
  });

  it("ends stored BFF sessions on request", async () => {
    const { db } = await legacyDb();
    await applyHardening(db, { includeSessionStore: true });
    await rows(
      db,
      `insert into public.bff_sessions (id, user_id, email, sealed, access_expires_at, created_at, last_seen_at, absolute_expires_at, account)
       values ('h1', $1, 'a@example.com', 'v1.x', 1, 1, 1, 9999999999999, '{}'::jsonb),
              ('h2', $1, 'a@example.com', 'v1.y', 1, 1, 1, 9999999999999, '{}'::jsonb),
              ('h3', $2, 'b@example.com', 'v1.z', 1, 1, 1, 9999999999999, '{}'::jsonb)`,
      [DRIVER_A, "22222222-2222-2222-2222-222222222222"],
    );

    const result = await revokeUserSessions(db, "a@example.com");
    expect(result).toMatchObject({ ok: true, revoked: 2 });

    const left = await rows<{ id: string }>(db, "select id from public.bff_sessions");
    expect(left.map((row) => row.id)).toEqual(["h3"]);
  });

  it("reports a missing session table instead of failing", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    const result = await revokeUserSessions(db, "a@example.com");
    expect(result).toMatchObject({ ok: true, revoked: 0 });
    expect(result.note).toMatch(/does not exist/);
  });
});

describe("assigning pre-0005 rows", () => {
  it("lists every ownerless campaign", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);

    const pending = await listOwnerlessCampaigns(db);
    expect(pending.map((row) => row.id)).toEqual(["camp_a_draft", "camp_a_pending", "camp_approved", "camp_b_draft"]);
    expect(pending.every((row) => row.title)).toBe(true);
  });

  it("assigns them all when only one account exists", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    await rows(db, "delete from auth.users where id <> $1", [DRIVER_A]);

    const result = await assignLegacyOwners(db, { owner: "a@example.com" });
    expect(result).toMatchObject({ ok: true, assigned: 4, ownerId: DRIVER_A });
    expect(await listOwnerlessCampaigns(db)).toHaveLength(0);

    // …and the driver can now see their own campaigns.
    const owned = await as(db, driverA, () => rows(db, "select id from public.campaigns order by id"));
    expect(owned).toHaveLength(4);
  });

  it("refuses to guess when several accounts exist", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);

    const result = await assignLegacyOwners(db, { owner: "a@example.com" });
    expect(result).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(result.message).toMatch(/--ids/);
    // Nothing was assigned by the refusal.
    expect(await listOwnerlessCampaigns(db)).toHaveLength(4);
  });

  it("assigns an explicit subset, and only that subset", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);

    const result = await assignLegacyOwners(db, { owner: "b@example.com", ids: ["camp_b_draft", "camp_a_pending"] });
    expect(result).toMatchObject({ ok: true, assigned: 2, ownerId: "22222222-2222-2222-2222-222222222222" });
    expect(result.ids?.sort()).toEqual(["camp_a_pending", "camp_b_draft"]);

    const remaining = await listOwnerlessCampaigns(db);
    expect(remaining.map((row) => row.id)).toEqual(["camp_a_draft", "camp_approved"]);
  });

  it("accepts a UUID as well as an address", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    const result = await assignLegacyOwners(db, { owner: "22222222-2222-2222-2222-222222222222", ids: ["camp_a_draft"] });
    expect(result).toMatchObject({ ok: true, assigned: 1, ownerId: "22222222-2222-2222-2222-222222222222" });
  });

  it("says an approved row is still going to be read-only for its owner", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    const result = await assignLegacyOwners(db, { owner: "a@example.com", ids: ["camp_approved"] });
    expect(result).toMatchObject({ ok: true, assigned: 1, frozen: ["camp_approved"] });
  });

  it("reports an address that has never signed up", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    const result = await assignLegacyOwners(db, { owner: "tic.raheel@gmail.com" });
    expect(result).toMatchObject({ ok: false, reason: "no-such-user" });
    expect(result.message).toContain("tic.raheel@gmail.com");
  });

  it("is safe to run twice", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    await rows(db, "delete from auth.users where id <> $1", [DRIVER_A]);

    expect(await assignLegacyOwners(db, { owner: "a@example.com" })).toMatchObject({ ok: true, assigned: 4 });
    expect(await assignLegacyOwners(db, { owner: "a@example.com" })).toMatchObject({ ok: true, assigned: 0, reason: "nothing-to-do" });
  });

  it("never steals a row that already has an owner", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    await as(db, reviewer, () => rows(db, "update public.campaigns set owner = $1 where id = 'camp_b_draft'", ["22222222-2222-2222-2222-222222222222"]));

    const result = await assignLegacyOwners(db, { owner: "a@example.com", ids: ["camp_b_draft"] });
    expect(result).toMatchObject({ ok: false, reason: "no-match" });

    const [row] = await rows<{ owner: string }>(db, "select owner from public.campaigns where id = 'camp_b_draft'");
    expect(row.owner).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("does not change what a display can see", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    const before = await as(db, anon, () => rows(db, "select id from public.public_campaigns"));
    await assignLegacyOwners(db, { owner: "a@example.com" });
    const after = await as(db, anon, () => rows(db, "select id from public.public_campaigns"));
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  });
});

describe("the session store migration", () => {
  it("keeps bff_sessions unreachable from the browser", async () => {
    const { db } = await legacyDb();
    await applyHardening(db, { includeSessionStore: true });

    for (const actor of [anon, driverA]) {
      const message = await denied(() => as(db, actor, () => rows(db, "select * from public.bff_sessions")));
      expect(message).toMatch(/permission denied/i);
    }
  });

  it("is applied only when asked", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    expect(await rows(db, "select to_regclass('public.bff_sessions') as t")).toEqual([{ t: null }]);
  });
});

describe("the grant script's SQL transport", () => {
  it("explains that the account must exist before the role can be granted", async () => {
    // The most likely first-run failure on a real project is naming an address
    // that has never signed up: the SQL editor would just say "no rows", so the
    // script has to say what to do instead.
    const { db } = await legacyDb();
    await applyHardening(db);
    const result = await grantReviewer(db, "tic.raheel@gmail.com", { revokeSessions: true });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("tic.raheel@gmail.com");
    expect(result.message).toContain("re-run");
  });

  it("grants to the account after it exists", async () => {
    const { db } = await legacyDb();
    await applyHardening(db);
    await rows(db, "insert into auth.users (id, email) values (gen_random_uuid(), 'tic.raheel@gmail.com')");

    const result = await grantReviewer(db, "tic.raheel@gmail.com", { revokeSessions: true });
    expect(result).toMatchObject({ ok: true, role: "admin" });

    const [user] = await rows<{ raw_app_meta_data: Record<string, unknown> }>(
      db,
      "select raw_app_meta_data from auth.users where email = 'tic.raheel@gmail.com'",
    );
    expect(user.raw_app_meta_data).toEqual({ role: "admin" });
  });
});
