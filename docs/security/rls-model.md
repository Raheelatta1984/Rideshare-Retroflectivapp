# Supabase access model

Migrations `0005_tenant_isolation.sql` and `0006_public_projections.sql`
replace the policies from `0001`–`0004`. This document is the human-readable
version: who may read what, what breaks, and how it is verified.

## Why it had to change

The original policies said, in comments, "everyone may READ approved campaigns
… only authenticated users may WRITE campaigns". The SQL said:

```sql
create policy campaigns_read   on public.campaigns for select using (true);
create policy campaigns_write  on public.campaigns for insert to authenticated with check (true);
create policy campaigns_update on public.campaigns for update to authenticated using (true) with check (true);
create policy campaigns_delete on public.campaigns for delete to authenticated using (true);
```

`using (true)` on `select` means every draft, every campaign payload (including
the six consent records with signer names and emails) and every unapproved
creative was readable by anyone holding the anon key — which ships in the
browser bundle. `with check (true)` on write means any signed-in user could
overwrite or delete anyone else's campaign, and could mark their own content
approved. `0003` added a `booth_directory` view that ran with the definer's
rights and exposed every booth: owner uuid, name, city, creation time and both
pair codes, enumerable with a single query.

Those are not isolation boundaries, and the previous documentation said so. This
change builds the boundary.

## Roles

| Role | What it means | How it is established |
| --- | --- | --- |
| `anon` | Anyone with the public anon key (an unauthenticated display, a browser) | Supabase grants |
| `authenticated` | A signed-in Supabase user | JWT `sub` |
| reviewer (`admin`) | A user who may approve, reject and reopen campaigns | JWT `app_metadata.role = 'admin'` |
| `service_role` / `postgres` | Operator, data plane, migrations | RLS bypass; review trigger short-circuits |

`app_metadata` can only be written through the Admin API or the SQL editor — a
user cannot set it from the app, unlike `user_metadata`. Grant the reviewer role
with the helper:

```sql
select public.grant_admin('owner@example.com');        -- requires postgres / service_role
-- or, without the helper:
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
 where email = 'owner@example.com';
```

The user must sign in again for a fresh JWT to carry the claim.

## Who may do what

### campaigns

| Actor | Read | Insert | Update | Delete |
| --- | --- | --- | --- | --- |
| `anon` | **nothing** (no privilege on the table) | – | – | – |
| driver | own rows + approved rows | own rows, `draft`/`pending` only | own rows, but never to/from `approved`, and never an already-approved row | own rows |
| reviewer | all | any | any | any |
| operator | all | any | any | any |

`public.public_campaigns` is the **only** anonymous read path: approved rows,
no `owner` column, and the six consent records reduced to
`{confirmed, signerName: "on file", agreementReference: "on file"}`. The display
still gets the answer it needs ("are the consents signed?") without a person's
name, email or signature reference. Non-personal terms (merchant, expiry,
privacy policy URL, QR/consent flags) survive because the referral copy shows
them.

### approval_audit

Append-only. No anonymous access. Owners read the audit for their own campaigns;
reviewers read everything. Writes come from a database trigger on every
`approval_state` transition (with `auth.uid()` recorded in `reviewer_id`), so a
decision cannot exist without a record; reviewers may additionally post their
own note.

### campaign_events

| Actor | Read | Insert |
| --- | --- | --- |
| `anon` | **nothing** | only for a campaign that is `approved` **right now**, with a timestamp within −7 days…+1 day |
| driver | own campaigns | own or approved campaigns |
| reviewer | all | any |

Per-device dwell times and play counts are telemetry about a specific vehicle.
They are no longer public; the aggregate rollup (`campaign_play_counts`) is
`security_invoker`, so it only counts what the caller may already read.

### booths, devices, storage

* `booths` — owner-scoped, no anonymous access at all.
* `devices` — owner-scoped, no anonymous access.
* `storage.objects` in the `campaigns` bucket — insert/update/delete only into
  the folder of a campaign you own (`shard-NNNN/<campaignId>/…`); reads for
  approved campaigns and your own. The bucket stays public **on purpose**: the
  asset is the advertisement, displayed on a vehicle in traffic. What changed is
  that "signed in" no longer means "can overwrite any campaign's creative".

### id_shards / image_machines / image_shards

Reads stay public (shard ownership is infrastructure config, like a snowflake
epoch). Writes are reviewer-only: previously any authenticated user could
rebalance the fleet map. `next_id()` is no longer executable by browser roles.

## Pair codes

The enumerable view is gone. `public.resolve_pair_code(text)` is an exact-match
`SECURITY DEFINER` function returning `{found, position}` — no owner, no name, no
city, no timestamps, no second code. Six characters is ~31 bits, so the lookup
is rate limited in the BFF (20/minute/client) rather than trusted to be
unguessable. The client no longer adopts an account from a code: it confirms the
code and pairs over the pair-code channel, which is what actually carries the
session.

## Breaking changes

These are deliberate and each one closes a hole:

1. **A driver cannot approve their own campaign.** `approval_state` may only
   move to `approved`/`rejected` when the JWT says reviewer. The app's approval
   panel still works — for reviewers.
2. **An approved campaign is read-only for its owner.** Editing copy after
   approval is the classic bait-and-switch; a reviewer reopens it first.
3. **Anonymous reads of `campaigns`, `approval_audit` and `campaign_events`
   return nothing.** Clients use `public_campaigns`; both adapters already do.
4. **Pair-code resolution returns no account.** Terminals pair by code, not by
   adopting the booth's identity.
5. **Existing rows with `owner = null`** (everything created before 0005) stay
   publicly visible when approved and are otherwise manageable by reviewers
   only. Reassign deliberately:

```sql
update public.campaigns set owner = '<uuid>' where id = '<campaign id>';
```

## Deployment order

`0005` revokes every anonymous privilege on `public.campaigns`; `0006` creates
`public.public_campaigns`, the only replacement. **They must be applied in one
transaction.** Separately, a display that polls in between gets an empty
playlist (a safe failure — it never leaks a draft — but an outage all the same),
and if `0006` fails on its own the app is left with no anonymous read path at
all. `scripts/apply-hardening.mjs` exists to make that impossible.

```bash
# 1. Dry run: applies 0005 + 0006 inside a transaction, runs the post-conditions,
#    then rolls back. Nothing is changed; the DDL is still proven valid.
DATABASE_URL='postgres://postgres:<password>@db.<project>.supabase.co:5432/postgres' \
  npm run db:harden -- --dry-run

# 2. Apply, and grant the reviewer role in the same run. --revoke-sessions ends
#    that account's stored BFF sessions so the next request forces a fresh login.
DATABASE_URL='postgres://…' \
  npm run db:harden -- --apply --grant-admin tic.raheel@gmail.com --revoke-sessions

# 3. The BFF uses BFF_SESSION_STORE=postgres (it needs public.bff_sessions):
DATABASE_URL='postgres://…' npm run db:harden -- --apply --include-session-store

# 4. Sign that account in again. The role lives in the JWT: a browser-held token
#    from before the grant cannot carry it. (With the BFF the next approve/reject
#    reissues the token and picks the role up automatically; a static-only
#    deployment has no such path, so re-login there.)
```

`DATABASE_URL` must be a **direct/session connection with DDL rights** (the
`postgres` role), not the anon key and not a transaction-mode pooler.

The script fails the deploy unless every post-condition holds, and it prints
each one:

```
✓ applied 0005_tenant_isolation.sql, 0006_public_projections.sql in one transaction
  ✓ public_campaigns projection exists
  ✓ legacy booth_directory view is gone
  ✓ anon cannot read campaigns
  ✓ anon cannot read campaign_events
  ✓ anon can read the projection
  ✓ no permissive policy remains on tenant tables
  ✓ owner defaults to auth.uid()
  ✓ grant_admin is not callable by browser roles
```

### If the grant fails: "no Supabase auth user with that address"

That is the normal first-run outcome when the address has never signed up in
this project — the leaked administrator password belonged to an email account,
not necessarily to a `auth.users` row. Create or sign up the account, then re-run
just the grant (it is idempotent):

```bash
# SQL transport (needs DATABASE_URL):
DATABASE_URL='postgres://…' npm run auth:grant-admin -- --email tic.raheel@gmail.com --apply --revoke-sessions

# Admin API transport (needs only the service-role key, no DB password):
SUPABASE_URL='https://<project>.supabase.co' SUPABASE_SERVICE_ROLE_KEY='…' \
  npm run auth:grant-admin -- --email tic.raheel@gmail.com --via api --apply --revoke-sessions
```

Both transports merge `app_metadata` rather than replacing it, and both are
idempotent. Neither is reachable from the browser: `public.grant_admin` is
revoked from `anon` and `authenticated`, and the equivalent SQL is

```sql
select public.grant_admin('tic.raheel@gmail.com');
```

### Reassign pre-0005 rows

Rows created before this migration have `owner = null`; they stay publicly
visible when approved and are otherwise reviewer-managed. Assign them while you
are thinking about it:

```sql
update public.campaigns set owner = '<uuid>' where id = '<campaign id>';
```

### Then

5. Deploy the app build that reads `public_campaigns` (this repository).
6. Verify with the queries below, not with the dashboard.

## Verifying a live project

```sql
-- Every policy on the campaign tables, with its predicate.
select tablename, policyname, roles, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('campaigns','approval_audit','campaign_events','devices','booths')
 order by tablename, policyname;

-- Nothing permissive should remain.
select tablename, policyname from pg_policies
 where schemaname = 'public' and coalesce(qual,'') = 'true';

-- The projection exists and is not owner-runnable by the caller.
select * from public.public_campaigns limit 1;

-- The old directory is gone.
select to_regclass('public.booth_directory');   -- expected: null
```

Reproduce those checks in CI with `npm run security:rls`, which applies
`0001`–`0007` to a real PostgreSQL (PGlite, WASM) and asserts 34 behaviours as
`anon`, two different drivers and a reviewer. Two more suites guard the deploy
itself:

* `supabase/tests/hardening.test.ts` (20 assertions) starts from the legacy
  state, applies `0005 + 0006` through the same module the CLI uses, and proves
  the pairing is atomic: a failure in `0006` rolls `0005` back, and a migration
  that leaves no anonymous read path fails its own verification. It also covers
  the reviewer grant — including that a stale token still cannot approve, which
  is why the runbook insists on signing in again.
* `scripts/sql-policy-audit.test.ts` fails the build if a later migration
  re-introduces a permissive policy, grants a write privilege to `anon`, or
  forgets a `search_path` on a definer function.
