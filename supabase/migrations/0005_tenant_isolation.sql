-- 0005 · Tenant isolation, review authority and storage scoping
--
-- This migration replaces the "everyone may read everything, any signed-in
-- user may write anything" policies from 0001 with an ownership + role model.
-- Read 0001's header first: it states the original intent ("everyone may READ
-- approved campaigns"), which the policies never actually implemented — the
-- select policy was `using (true)`.
--
-- What changes
--
--   campaigns        owned rows; anonymous readers lose direct table access
--                    entirely (they read public.public_campaigns in 0006)
--   approval_audit   no anonymous reads; no free-form writes
--   campaign_events  anonymous writes only for *approved* campaigns; no
--                    anonymous reads (device ids and dwell times are telemetry)
--   devices          owner-scoped (was already, now explicit and complete)
--   booths           no anonymous reads (the enumerable directory view is
--                    replaced by an RPC in 0006)
--   storage.objects  uploads/updates/deletes only into a campaign you own
--   id_shards        writes are admin-only (was: any authenticated user could
--   image_machines   rebalance the fleet map)
--   image_shards
--
-- Who is a reviewer
--
--   A user is a reviewer when their JWT carries `app_metadata.role = 'admin'`.
--   `app_metadata` is written only by the Admin API / SQL editor — never by the
--   user — so it is not self-assignable. Grant it to the account operator:
--
--     update auth.users
--        set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
--                                || '{"role":"admin"}'::jsonb
--      where email = '<owner email>';
--
--   Re-login afterwards so a fresh JWT carries the claim.
--
-- Breaking changes (deliberate, documented in docs/security/rls-model.md)
--
--   * A driver can no longer approve their own campaign, and an approved
--     campaign becomes read-only for its owner. Only a reviewer can approve or
--     reject, and only a reviewer can edit approved content.
--   * Anonymous reads of `campaigns`, `approval_audit` and `campaign_events`
--     return nothing. Clients must use `public_campaigns` (0006).
--
-- Apply after 0001–0004. Existing rows keep working: approved rows stay
-- publicly readable through the projection, drafts and stored payloads become
-- private, and rows with a null owner are manageable by reviewers only.

-- ------------------------------------------------------------------ helpers

-- A reviewer is an account whose app_metadata says so. `app_metadata` cannot be
-- set by the user (unlike `user_metadata`), which is what makes it usable here.
create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

comment on function public.is_admin() is
  'True when the request JWT carries app_metadata.role = admin. Set it through the Admin API or the SQL editor, never from the app.';

-- SECURITY DEFINER because anonymous callers have no SELECT on campaigns; the
-- function answers one yes/no question and reveals nothing else.
create or replace function public.campaign_is_public(p_campaign_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.campaigns c
     where c.id = p_campaign_id
       and c.approval_state = 'approved'
  );
$$;

revoke all on function public.campaign_is_public(text) from public;
grant execute on function public.campaign_is_public(text) to anon, authenticated;

-- ---------------------------------------------------------------- ownership

alter table public.campaigns
  add column if not exists owner uuid references auth.users (id) on delete set null;

-- Default to the caller, so a client never has to (and never gets to) supply an
-- owner. An update that omits the column leaves the existing owner untouched,
-- which is what stops a reviewer from taking ownership of a row by approving it.
alter table public.campaigns alter column owner set default auth.uid();

create index if not exists campaigns_owner_idx on public.campaigns (owner);

comment on column public.campaigns.owner is
  'Creator of the row. RLS scopes reads and writes to this column; reviewers (is_admin) see everything.';

-- No backfill: the old schema recorded no creator, and guessing one from the
-- audit trail would hand a real account ownership of rows it may not have
-- written. Rows with a null owner stay visible when approved and are otherwise
-- manageable by reviewers only. Reassign deliberately if you need to:
--
--   update public.campaigns set owner = '<uuid>' where id = '<campaign id>';

-- The audit trail gains a real user id (a free-text reviewer name is not an
-- authorization record).
alter table public.approval_audit
  add column if not exists reviewer_id uuid;

comment on column public.approval_audit.reviewer_id is
  'auth.uid() of the reviewer at decision time. Set by trigger; never trusted from the client.';

-- ----------------------------------------------------------- review authority

create or replace function public.enforce_review_authority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Only the two browser-facing roles are untrusted. `service_role` (the data
  -- plane), `postgres` (SQL editor, migrations) and any operator-created role
  -- keep full control: they are already past authentication, and blocking them
  -- would make an approval impossible to backfill or repair.
  if current_user not in ('anon', 'authenticated') or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.approval_state in ('approved', 'rejected') then
      raise exception 'only a reviewer can approve or reject a campaign'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.approval_state = 'approved' then
    raise exception 'approved campaigns are read-only for their owner; ask a reviewer to reopen this one'
      using errcode = 'insufficient_privilege';
  end if;

  if new.approval_state in ('approved', 'rejected') then
    raise exception 'only a reviewer can approve or reject a campaign'
      using errcode = 'insufficient_privilege';
  end if;

  -- The owner may not move the row *out* of a review decision either: that
  -- would let them take a rejected campaign back to draft and rewrite it after
  -- review. Only a reviewer reopens a decided campaign.
  if old.approval_state in ('approved', 'rejected') then
    raise exception 'only a reviewer can change a reviewed campaign'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists campaigns_review_guard on public.campaigns;
create trigger campaigns_review_guard
  before insert or update on public.campaigns
  for each row execute function public.enforce_review_authority();

-- Append-only audit written by the database itself, so a decision cannot be
-- taken without a record even if the client forgets to post one.
create or replace function public.record_campaign_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_email text := auth.jwt() ->> 'email';
begin
  if tg_op = 'UPDATE' and new.approval_state is not distinct from old.approval_state then
    return null;
  end if;

  insert into public.approval_audit (campaign_id, state, reviewer, reviewer_id, note)
  values (
    new.id,
    new.approval_state,
    coalesce(v_email, v_actor::text),
    v_actor,
    case
      when tg_op = 'INSERT' then 'campaign created'
      when new.approval_state = 'approved' then 'approved'
      when new.approval_state = 'rejected' then 'rejected'
      else 'returned to ' || new.approval_state
    end
  );
  return null;
end;
$$;

drop trigger if exists campaigns_audit_trail on public.campaigns;
create trigger campaigns_audit_trail
  after insert or update of approval_state on public.campaigns
  for each row execute function public.record_campaign_review();

-- ------------------------------------------------------------- campaigns RLS

drop policy if exists campaigns_read on public.campaigns;
drop policy if exists campaigns_write on public.campaigns;
drop policy if exists campaigns_update on public.campaigns;
drop policy if exists campaigns_delete on public.campaigns;
drop policy if exists campaigns_public_read on public.campaigns;
drop policy if exists campaigns_own_read on public.campaigns;
drop policy if exists campaigns_owner_insert on public.campaigns;
drop policy if exists campaigns_owner_update on public.campaigns;
drop policy if exists campaigns_owner_delete on public.campaigns;
drop policy if exists campaigns_admin_all on public.campaigns;

-- Signed-in users see their own rows plus approved rows (a driver still needs
-- to know which of their campaigns are live) plus everything if they review.
create policy campaigns_own_read on public.campaigns
  for select to authenticated
  using (owner = auth.uid() or approval_state = 'approved' or public.is_admin());

create policy campaigns_owner_insert on public.campaigns
  for insert to authenticated
  with check (owner = auth.uid() and approval_state in ('draft', 'pending'));

create policy campaigns_owner_update on public.campaigns
  for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

create policy campaigns_owner_delete on public.campaigns
  for delete to authenticated
  using (owner = auth.uid());

create policy campaigns_admin_all on public.campaigns
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Anonymous callers get no direct access at all: the projection in 0006 is the
-- only anonymous read path, and it cannot be widened by a future policy.
revoke all on public.campaigns from anon;
grant select, insert, update, delete on public.campaigns to authenticated;

-- -------------------------------------------------------- approval_audit RLS

drop policy if exists approval_audit_read on public.approval_audit;
drop policy if exists approval_audit_insert on public.approval_audit;

create policy approval_audit_read on public.approval_audit
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.campaigns c
       where c.id = approval_audit.campaign_id
         and c.owner = auth.uid()
    )
  );

-- Reviewers may record their own decision through the API; the trigger above
-- records every transition regardless. Owners cannot write audit rows.
create policy approval_audit_insert on public.approval_audit
  for insert to authenticated
  with check (public.is_admin());

revoke all on public.approval_audit from anon;
grant select, insert on public.approval_audit to authenticated;

-- --------------------------------------------------------- campaign_events RLS

drop policy if exists campaign_events_insert on public.campaign_events;
drop policy if exists campaign_events_read on public.campaign_events;

-- Timestamps are attacker-supplied on the anonymous path; a future or ancient
-- "play" would corrupt the proof-of-play rollup.
create or replace function public.campaign_event_is_plausible(p_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_at is not null
     and p_at > now() - interval '7 days'
     and p_at < now() + interval '1 day';
$$;

grant execute on function public.campaign_event_is_plausible(timestamptz) to anon, authenticated;

-- Displays run without an account, so anonymous INSERT stays available — but
-- only for a campaign that is actually approved right now.
create policy campaign_events_insert on public.campaign_events
  for insert to anon, authenticated
  with check (
    kind in ('proof-of-play', 'qr-scan', 'referral-conversion')
    and public.campaign_is_public(campaign_id)
    and public.campaign_event_is_plausible(at)
  );

create policy campaign_events_read on public.campaign_events
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.campaigns c
       where c.id = campaign_events.campaign_id
         and c.owner = auth.uid()
    )
  );

revoke all on public.campaign_events from anon;
grant insert on public.campaign_events to anon;
grant select, insert on public.campaign_events to authenticated;

-- ------------------------------------------------------------------ devices

drop policy if exists devices_own on public.devices;
drop policy if exists devices_own_read on public.devices;
drop policy if exists devices_owner_all on public.devices;

create policy devices_owner_all on public.devices
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

revoke all on public.devices from anon;
grant select, insert, update, delete on public.devices to authenticated;

-- ------------------------------------------------------------------- booths

revoke all on public.booths from anon;
grant select, insert, update, delete on public.booths to authenticated;

-- ------------------------------------------------------------------ storage
-- Uploads are scoped to the campaign they belong to: the object key is
-- `shard-NNNN/<campaignId>/<file>` (src/lib/backend/imageShards.ts), so
-- split_part(name, '/', 2) is the campaign id.
--
-- Reads: the bucket stays public on purpose. These objects are the creative
-- that is displayed on a vehicle in traffic; the read exposure is the product.
-- What was wrong before is that *anyone signed in* could write over any
-- campaign's assets. That is what the policies below stop. To make reads
-- private too, flip `storage.buckets.public` to false and serve
-- `assets.signedUrl()` from the app (the adapter already supports it).

drop policy if exists campaign_assets_read on storage.objects;
drop policy if exists campaign_assets_write on storage.objects;
drop policy if exists campaign_assets_update on storage.objects;
drop policy if exists campaign_assets_delete on storage.objects;
drop policy if exists campaign_assets_insert_scoped on storage.objects;

-- Security-definer helpers keep the policy expressions short and, more
-- importantly, let an anonymous caller ask "is this asset public?" without
-- holding SELECT on campaigns.
create or replace function public.campaign_asset_is_readable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.campaigns c
     where c.id = split_part(p_object_name, '/', 2)
       and (c.approval_state = 'approved' or c.owner = auth.uid())
  ) or public.is_admin();
$$;

create or replace function public.campaign_asset_is_writable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1
      from public.campaigns c
     where c.id = split_part(p_object_name, '/', 2)
       and c.owner = auth.uid()
  );
$$;

revoke all on function public.campaign_asset_is_readable(text) from public;
revoke all on function public.campaign_asset_is_writable(text) from public;
grant execute on function public.campaign_asset_is_readable(text) to anon, authenticated;
grant execute on function public.campaign_asset_is_writable(text) to authenticated;

create policy campaign_assets_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'campaigns' and public.campaign_asset_is_readable(name));

create policy campaign_assets_insert_scoped on storage.objects
  for insert to authenticated
  with check (bucket_id = 'campaigns' and public.campaign_asset_is_writable(name));

create policy campaign_assets_update on storage.objects
  for update to authenticated
  using (bucket_id = 'campaigns' and public.campaign_asset_is_writable(name));

create policy campaign_assets_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'campaigns' and public.campaign_asset_is_writable(name));

-- ------------------------------------------------------- id plane (0004 RLS)

drop policy if exists id_shards_write on public.id_shards;
create policy id_shards_write on public.id_shards
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists image_machines_write on public.image_machines;
create policy image_machines_write on public.image_machines
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists image_shards_write on public.image_shards;
create policy image_shards_write on public.image_shards
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Minting ids is a server-side operation (the data plane as service_role);
-- a browser has no reason to consume the shared counter.
revoke execute on function public.next_id(smallint) from anon, authenticated;

-- ------------------------------------------------------- operator helper
-- Grant a reviewer without hand-writing JSON into auth.users. Executable only
-- by the service role / postgres, so it cannot be called by the app.
create or replace function public.grant_admin(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'admin'),
         updated_at = now()
   where lower(email) = lower(p_email);

  if not found then
    raise exception 'no auth user with email %', p_email;
  end if;
end;
$$;

revoke all on function public.grant_admin(text) from public;
revoke all on function public.grant_admin(text) from anon, authenticated;
