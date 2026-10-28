-- 0007 · Session table for the BFF (server/bff)
--
-- Only needed when the session service runs with `BFF_SESSION_STORE=postgres`.
-- A single-host deployment can use `BFF_SESSION_FILE` instead and skip this.
--
-- The table stores, per session:
--   id                  sha256 of the opaque cookie token (never the token)
--   sealed              AES-256-GCM(access_token, refresh_token) when
--                       BFF_SESSION_KEY is set — plaintext-style base64 only in
--                       development, which the server warns about on boot
--   absolute_expires_at the hard 12 h ceiling; idle expiry is decided by the BFF
--   account             the snapshot the browser is allowed to see
--
-- It is not part of the Supabase API surface: RLS is on with no policies, and
-- anon/authenticated are revoked outright. The BFF connects with a privileged
-- role (BFF_DATABASE_URL); the browser has no path here at all.

create table if not exists public.bff_sessions (
  id                  text primary key,
  user_id             text not null,
  email               text not null,
  sealed              text not null,
  access_expires_at   bigint not null,
  created_at          bigint not null,
  last_seen_at        bigint not null,
  absolute_expires_at bigint not null,
  account             jsonb not null default '{}'::jsonb
);

create index if not exists bff_sessions_user_idx on public.bff_sessions (user_id);
create index if not exists bff_sessions_expiry_idx on public.bff_sessions (absolute_expires_at);

alter table public.bff_sessions enable row level security;

-- No policies on purpose: nothing but the owning role may touch this table.
revoke all on public.bff_sessions from anon, authenticated, public;

comment on table public.bff_sessions is
  'Server-side sessions for the BFF (server/bff). Keyed by sha256(token); upstream tokens sealed with BFF_SESSION_KEY. Not reachable from the app.';

-- Housekeeping: expired rows are harmless (the BFF refuses them) but they keep
-- the refresh tokens alive at rest. If pg_cron is available, prune hourly:
--
--   select cron.schedule('bff-session-purge', '7 * * * *',
--     $$delete from public.bff_sessions where absolute_expires_at < (extract(epoch from now()) * 1000)$$);
