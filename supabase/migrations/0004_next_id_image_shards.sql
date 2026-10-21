-- next_id + shard planes · 0004 — 64-bit sortable ids, image logical shards,
-- and the machine map.
--
-- Covers two production problems:
--
--   1. ID clashes. `next_id()` mints 64-bit ids in three parts —
--      41 bits of milliseconds since 2026-01-01T00:00:00Z | 13-bit shard
--      reference | 10-bit counter — exactly matching `src/lib/nextId.ts`.
--      The shard row is locked while minting, so concurrent writers can never
--      produce the same value, and the high-bit timestamp keeps ids sorted by
--      mint time (sortable as `bigint`, and as fixed-width decimal text).
--
--   2. Image placement. Object keys hash into the same 13-bit shard space
--      (`logical_shard_for` mirrors the FNV-1a in imageShards.ts), and the
--      image_shards/image_machines tables are the machine map: moving a shard
--      between machines is an UPDATE here plus a map edit — never a rehash of
--      every key.
--
-- Apply after 0001–0003 (Supabase SQL editor or `supabase db push`).

-- ------------------------------------------------------------------ id_shards
-- One row per minting shard reference (0‥8191). `last_ms`/`counter` are the
-- authoritative mint state; `machine` records which generator owns the shard.
create table if not exists public.id_shards (
  shard_ref   smallint primary key check (shard_ref between 0 and 8191),
  machine     text not null default 'unassigned',
  last_ms     bigint not null default 0,
  counter     integer not null default 0 check (counter between 0 and 1023),
  updated_at  timestamptz not null default now()
);

alter table public.id_shards enable row level security;

drop policy if exists id_shards_read on public.id_shards;
create policy id_shards_read on public.id_shards
  for select using (true); -- shard ownership is public knowledge (like a snowflake epoch)

drop policy if exists id_shards_write on public.id_shards;
create policy id_shards_write on public.id_shards
  for all to authenticated using (true) with check (true);

-- ----------------------------------------------------------------- next_id()
-- Mint one 64-bit id. p_shard names the minting shard; when NULL the
-- least-recently-used shard is picked so a fleet of callers balances naturally.
--
-- Layout: (ms_since_epoch_2026 << 23) | (shard_ref << 10) | counter
--   - timestamp field exhausted ~2095 (69.7 years); fits signed bigint
--     (sign bit clear) until 2060 — parse as numeric/unsigned after that.
--   - counter wraps by rolling the timestamp forward one millisecond, so the
--     function is monotonic and never blocks.
create or replace function public.next_id(p_shard smallint default null)
returns bigint
language plpgsql
as $$
declare
  -- 2026-01-01T00:00:00Z in Unix milliseconds — must match ID_EPOCH_MS in src/lib/nextId.ts
  c_epoch constant bigint := 1767225600000;
  v_shard   smallint;
  v_now_ms  bigint;
  v_last_ms bigint;
  v_counter integer;
begin
  if p_shard is not null and (p_shard < 0 or p_shard > 8191) then
    raise exception 'next_id: shard reference must be 0‥8191, got %', p_shard;
  end if;

  if p_shard is null then
    select s.shard_ref into v_shard
      from public.id_shards s
      order by s.last_ms, s.counter, s.shard_ref
      limit 1
      for update skip locked;
    if v_shard is null then
      -- No shard rows yet: fall back to reference 0 and register it.
      v_shard := 0;
    end if;
  else
    v_shard := p_shard;
  end if;

  v_now_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint - c_epoch;

  insert into public.id_shards (shard_ref, machine, last_ms, counter)
  values (v_shard, 'unassigned', v_now_ms, 0)
  on conflict (shard_ref) do nothing;

  select s.last_ms, s.counter into v_last_ms, v_counter
    from public.id_shards s
    where s.shard_ref = v_shard
    for update;

  if v_now_ms > v_last_ms then
    v_last_ms := v_now_ms;
    v_counter := 0;
  else
    v_counter := v_counter + 1;
    if v_counter > 1023 then
      -- 10-bit counter exhausted inside one millisecond: roll the clock
      -- forward. Still monotonic, still sorted, never reuses a value.
      v_last_ms := v_last_ms + 1;
      v_counter := 0;
    end if;
  end if;

  update public.id_shards
     set last_ms = v_last_ms, counter = v_counter, updated_at = now()
   where shard_ref = v_shard;

  return (v_last_ms::bigint << 23) | (v_shard::bigint << 10) | v_counter::bigint;
end;
$$;

-- Decomposition helpers (mirror parseId() in src/lib/nextId.ts).
create or replace function public.next_id_timestamp_ms(p_id bigint)
returns bigint language sql immutable as $$
  select (p_id >> 23) + 1767225600000;
$$;

create or replace function public.next_id_shard(p_id bigint)
returns smallint language sql immutable as $$
  select ((p_id >> 10) & 8191)::smallint;
$$;

create or replace function public.next_id_counter(p_id bigint)
returns integer language sql immutable as $$
  select (p_id & 1023)::integer;
$$;

-- ------------------------------------------------------- image machine map
-- Physical machines that store image bytes.
create table if not exists public.image_machines (
  id          text primary key,
  base_url    text not null,
  region      text,
  healthy     boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Logical shard → owning machine. Exactly one row per shard reference; a
-- rebalance is UPDATE image_shards SET machine_id = … for the moved ranges,
-- then edit the machine map JSON the data plane loads (infra/image-machines*.json).
create table if not exists public.image_shards (
  shard_ref   smallint primary key check (shard_ref between 0 and 8191),
  machine_id  text not null references public.image_machines (id) on delete restrict,
  moved_at    timestamptz
);

alter table public.image_machines enable row level security;
alter table public.image_shards   enable row level security;

drop policy if exists image_machines_read on public.image_machines;
create policy image_machines_read on public.image_machines
  for select using (true); -- displays resolve machines anonymously

drop policy if exists image_shards_read on public.image_shards;
create policy image_shards_read on public.image_shards
  for select using (true);

drop policy if exists image_machines_write on public.image_machines;
create policy image_machines_write on public.image_machines
  for all to authenticated using (true) with check (true);

drop policy if exists image_shards_write on public.image_shards;
create policy image_shards_write on public.image_shards
  for all to authenticated using (true) with check (true);

-- FNV-1a 32-bit over UTF-8 bytes — same hash as fnv1a32() in
-- src/lib/backend/imageShards.ts, so a key maps to the same shard in the
-- database and in the app.
create or replace function public.fnv1a32(input text)
returns bigint
language plpgsql
immutable
as $$
declare
  bytes bytea;
  i int;
  b int;
  h bigint := 2166136261; -- 0x811c9dc5
begin
  bytes := convert_to(input, 'UTF8');
  for i in 0 .. length(bytes) - 1 loop
    b := get_byte(bytes, i);
    h := ((h # b) * 16777619) & 4294967295;
  end loop;
  return h;
end;
$$;

create or replace function public.logical_shard_for(key text)
returns smallint
language sql
immutable
as $$
  select (public.fnv1a32(key) % 8192)::smallint;
$$;

-- Convenience: resolve a key to its owning machine via the map.
create or replace function public.image_machine_for(key text)
returns text
language sql
stable
as $$
  select s.machine_id
    from public.image_shards s
   where s.shard_ref = public.logical_shard_for(key);
$$;
