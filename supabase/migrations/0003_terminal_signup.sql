-- Terminal sign-up · 0003 — booths, pair-code directory and the terminal registry
--
-- Purpose (see TERMINAL-SIGNUP.md):
--   One generic QR (?mode=terminal) is printed with every terminal. Scanning it
--   opens a bare sign-up/login shell. A driver who already has a pair code
--   enters it and is assigned straight away; a new driver signs up, a booth is
--   minted with fresh pair codes, and the terminal binds to it. Everything
--   after that is managed from the driver's phone.
--
-- The app runs without this migration: the local (on-device) adapter answers
-- every call, and the Supabase adapter falls back to it when a query fails.
-- Applying it is what makes one account work across the phone and the terminal
-- instead of per-browser.
--
-- RLS is on for everything. The anon key ships in the bundle, so policies —
-- not the key — are the boundary.

-- ------------------------------------------------------------------- booths
-- One row per account. Holds the pair codes so a terminal can be resolved to a
-- booth from any device, which the browser-local store cannot do.
create table if not exists public.booths (
  id              uuid primary key default gen_random_uuid(),
  owner           uuid unique references auth.users (id) on delete cascade,
  name            text not null,
  email           text,
  phone           text,
  city            text,
  pair_code       text not null unique,
  front_pair_code text unique,
  created_at      timestamptz not null default now()
);

create index if not exists booths_owner_idx       on public.booths (owner);
create index if not exists booths_pair_code_idx   on public.booths (pair_code);
create index if not exists booths_front_code_idx  on public.booths (front_pair_code);

alter table public.booths enable row level security;

drop policy if exists booths_own on public.booths;
create policy booths_own on public.booths
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- ---------------------------------------------------------- booth_directory
-- Anon-readable projection used by the terminal's "I already have a code"
-- path. It exists so a scanned code can be confirmed WITHOUT exposing contact
-- details: no email, no phone. Views run with the owner's privileges, so this
-- is readable by anon even though public.booths is not.
create or replace view public.booth_directory as
  select id,
         owner,
         name,
         city,
         pair_code,
         front_pair_code,
         created_at
  from public.booths;

grant select on public.booth_directory to anon, authenticated;

-- ------------------------------------------------------------------ devices
-- 0001 created the fleet registry (id, name, pair_code, position, last_seen,
-- owner). These columns turn it into the terminal registry the Assign step
-- writes to.
alter table public.devices
  add column if not exists device_key    text,
  add column if not exists account_email text,
  add column if not exists assigned_at   timestamptz not null default now(),
  add column if not exists origin        text,
  add column if not exists status        text not null default 'assigned';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'devices_origin_check'
  ) then
    alter table public.devices
      add constraint devices_origin_check
      check (origin is null or origin in ('signup', 'pair-code', 'email', 'console', 'url'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'devices_status_check'
  ) then
    alter table public.devices
      add constraint devices_status_check
      check (status in ('assigned', 'released'));
  end if;
end $$;

-- device_key is the terminal's own browser id (rf:tablet-device-id). One
-- physical terminal holds one position, so re-assigning rear -> front replaces
-- the row rather than adding a second one.
create unique index if not exists devices_device_key_position_idx
  on public.devices (device_key, position)
  where device_key is not null;

create index if not exists devices_assigned_at_idx on public.devices (assigned_at desc);

comment on column public.devices.device_key is
  'Stable per-browser id of the physical terminal (rf:tablet-device-id). Null for rows created before 0003.';

comment on column public.devices.origin is
  'signup: terminal created the account. pair-code: terminal joined an existing booth by code. email: account login on the terminal. console/url: assigned from the driver phone or a coded QR.';

-- Note on anonymous writes: a terminal that binds to a pair code WITHOUT an
-- account session records the assignment on the device only. There is no anon
-- insert policy here on purpose — an open devices insert would let anyone
-- attach a phantom terminal to any booth. Sign up (or log in) first, then the
-- authenticated devices_own policy from 0001 applies.

drop policy if exists devices_own_read on public.devices;
create policy devices_own_read on public.devices
  for select to authenticated using (owner = auth.uid());
