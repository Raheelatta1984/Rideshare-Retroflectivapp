-- Retroflex — Commercial Signage Phase 2 schema
-- Apply in the Supabase SQL editor (or `supabase db push`) on a fresh project.
--
-- Model (see COMMERCIAL-SIGNAGE-PLAN.md):
--   campaigns        one row per campaign; the full campaign object lives in `payload`
--                    so the app's TypeScript shape stays the single source of truth
--   approval_audit   append-only record of every review decision
--   campaign_events  the Event API: proof-of-play, QR scans, referral conversions
--   devices          display fleet registry (pair code → device)
--
-- Row Level Security is on for everything. The anon key is public, so policies —
-- not the key — are what protect the data.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- campaigns
create table if not exists public.campaigns (
  id              text primary key,
  title           text not null,
  approval_state  text not null default 'draft'
                  check (approval_state in ('draft','pending','approved','rejected')),
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists campaigns_updated_at_idx on public.campaigns (updated_at desc);
create index if not exists campaigns_approval_idx    on public.campaigns (approval_state);

-- ----------------------------------------------------------- approval_audit
create table if not exists public.approval_audit (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  text not null references public.campaigns (id) on delete cascade,
  state        text not null check (state in ('draft','pending','approved','rejected')),
  reviewer     text,
  note         text,
  reviewed_at  timestamptz not null default now()
);

create index if not exists approval_audit_campaign_idx on public.approval_audit (campaign_id, reviewed_at desc);

-- ---------------------------------------------------------- campaign_events
create table if not exists public.campaign_events (
  id             text primary key,
  campaign_id    text not null,
  device_id      text not null,
  pair_code      text,
  kind           text not null check (kind in ('proof-of-play','qr-scan','referral-conversion')),
  at             timestamptz not null default now(),
  dwell_seconds  numeric,
  meta           jsonb not null default '{}'::jsonb
);

create index if not exists campaign_events_at_idx       on public.campaign_events (at desc);
create index if not exists campaign_events_campaign_idx on public.campaign_events (campaign_id, at desc);

-- ----------------------------------------------------------------- devices
create table if not exists public.devices (
  id          text primary key,
  name        text not null,
  pair_code   text not null,
  position    text not null default 'rear' check (position in ('rear','front')),
  last_seen   timestamptz not null default now(),
  owner       uuid references auth.users (id) on delete set null
);

create index if not exists devices_pair_code_idx on public.devices (pair_code);

-- ------------------------------------------------------------------- RLS
alter table public.campaigns       enable row level security;
alter table public.approval_audit  enable row level security;
alter table public.campaign_events enable row level security;
alter table public.devices         enable row level security;

-- Supabase role helpers:
--   anon          = the key shipped in the browser
--   authenticated = a signed-in user (the driver/owner after auth)
--
-- Policy intent:
--   * everyone may READ approved campaigns (the display has to)
--   * only authenticated users may WRITE campaigns
--   * a campaign may only transition to 'approved' when the legal block is
--     complete, enforced in a trigger below — not just in app code
--   * displays may INSERT events; nobody may UPDATE or DELETE them (audit trail)

drop policy if exists campaigns_read on public.campaigns;
create policy campaigns_read on public.campaigns
  for select using (true);

drop policy if exists campaigns_write on public.campaigns;
create policy campaigns_write on public.campaigns
  for insert to authenticated with check (true);

drop policy if exists campaigns_update on public.campaigns;
create policy campaigns_update on public.campaigns
  for update to authenticated using (true) with check (true);

drop policy if exists campaigns_delete on public.campaigns;
create policy campaigns_delete on public.campaigns
  for delete to authenticated using (true);

-- Legal gate: the six consents must be signed before an approval is recorded.
create or replace function public.campaign_legal_complete(payload jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(
    (payload -> 'legal' ->> 'appOwner')          is not null
    and (payload -> 'legal' -> 'appOwner' ->> 'confirmed')::boolean
    and (payload -> 'legal' -> 'driver' ->> 'confirmed')::boolean
    and (payload -> 'legal' -> 'vehicleOwner' ->> 'confirmed')::boolean
    and (payload -> 'legal' -> 'campaignOwner' ->> 'confirmed')::boolean
    and (payload -> 'legal' -> 'trademarkAuthorization' ->> 'confirmed')::boolean
    and (payload -> 'legal' -> 'safetyAssessment' ->> 'confirmed')::boolean,
    false
  );
$$;

create or replace function public.enforce_campaign_approval()
returns trigger
language plpgsql
as $$
begin
  if new.approval_state = 'approved' and not public.campaign_legal_complete(new.payload) then
    raise exception 'campaign % cannot be approved: the six consents are not signed', new.id
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists campaigns_approval_guard on public.campaigns;
create trigger campaigns_approval_guard
  before insert or update on public.campaigns
  for each row execute function public.enforce_campaign_approval();

-- Audit rows are written by the app; readable by authenticated users.
drop policy if exists approval_audit_read on public.approval_audit;
create policy approval_audit_read on public.approval_audit
  for select to authenticated using (true);

drop policy if exists approval_audit_insert on public.approval_audit;
create policy approval_audit_insert on public.approval_audit
  for insert to authenticated with check (true);

-- Events: displays (anon) may insert and read aggregated rows; never mutate.
drop policy if exists campaign_events_insert on public.campaign_events;
create policy campaign_events_insert on public.campaign_events
  for insert with check (true);

drop policy if exists campaign_events_read on public.campaign_events;
create policy campaign_events_read on public.campaign_events
  for select using (true);

drop policy if exists devices_own on public.devices;
create policy devices_own on public.devices
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- ----------------------------------------------------------------- storage
-- Campaign assets live in a public-read bucket: the display fetches them
-- without auth, and the plan's Phase 2 signed-URL option can replace the URLs
-- in `payload.assetUrl` without touching the app.
insert into storage.buckets (id, name, public)
values ('campaigns', 'campaigns', true)
on conflict (id) do nothing;

drop policy if exists campaign_assets_read on storage.objects;
create policy campaign_assets_read on storage.objects
  for select using (bucket_id = 'campaigns');

drop policy if exists campaign_assets_write on storage.objects;
create policy campaign_assets_write on storage.objects
  for insert to authenticated with check (bucket_id = 'campaigns');

drop policy if exists campaign_assets_update on storage.objects;
create policy campaign_assets_update on storage.objects
  for update to authenticated using (bucket_id = 'campaigns');

-- -------------------------------------------------------------- realtime
-- Enable Realtime on campaigns so a console approval reaches the fleet
-- immediately (the app's polling adapter also works without this).
alter publication supabase_realtime add table public.campaigns;

-- ------------------------------------------------------------------ views
-- Proof-of-play rollup for the client campaign portal.
create or replace view public.campaign_play_counts as
  select campaign_id,
         count(*) filter (where kind = 'proof-of-play')      as plays,
         count(*) filter (where kind = 'qr-scan')             as scans,
         count(*) filter (where kind = 'referral-conversion') as conversions,
         max(at)                                              as last_event_at
  from public.campaign_events
  group by campaign_id;
