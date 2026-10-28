-- 0006 · Public projections
--
-- 0005 removed anonymous access to the raw tables. Displays and the pair-code
-- flow still need data without an account, so this migration publishes exactly
-- two narrow read paths and one write path, each of which reveals the minimum:
--
--   public.public_campaigns        approved campaigns, with consent PII removed
--   public.resolve_pair_code()     "does this code exist, and which end is it"
--   (campaign_events INSERT)       already granted in 0005 to anon, scoped to
--                                  approved campaigns
--
-- Everything else that used to be anonymously readable — the enumerable
-- `booth_directory` view (owner id, city, created_at, every pair code at once),
-- raw campaign payloads including the six consent records, and per-device event
-- telemetry — is gone.
--
-- Apply after 0005.

-- ------------------------------------------------------- consent redaction
--
-- The display has to answer "are the six consents signed?" before it shows a
-- regulated campaign (src/lib/signage.ts → campaignConsentIssues). It does not
-- need to know *who* signed. These helpers keep the answer and drop the answer
-- that identifies a person: signer name, email, agreement reference, timestamps.

create or replace function public.redacted_consent(p_consent jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_consent is null then null
    else jsonb_build_object(
      'confirmed', p_consent @> '{"confirmed": true}'::jsonb,
      'signerName', case
        when coalesce(btrim(p_consent ->> 'signerName'), '') <> '' then 'on file'
        else ''
      end,
      'agreementReference', case
        when coalesce(btrim(p_consent ->> 'agreementReference'), '') <> '' then 'on file'
        else ''
      end
    )
  end;
$$;

create or replace function public.redacted_legal(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_payload -> 'legal' is null or p_payload -> 'legal' = 'null'::jsonb then null
    else jsonb_build_object(
      'appOwner', public.redacted_consent(p_payload -> 'legal' -> 'appOwner'),
      'driver', public.redacted_consent(p_payload -> 'legal' -> 'driver'),
      'vehicleOwner', public.redacted_consent(p_payload -> 'legal' -> 'vehicleOwner'),
      'campaignOwner', public.redacted_consent(p_payload -> 'legal' -> 'campaignOwner'),
      'trademarkAuthorization', public.redacted_consent(p_payload -> 'legal' -> 'trademarkAuthorization'),
      'safetyAssessment', public.redacted_consent(p_payload -> 'legal' -> 'safetyAssessment'),
      -- Terms the reference/QR copy needs, all non-personal:
      'merchantName', p_payload -> 'legal' -> 'merchantName',
      'offerExpiry', p_payload -> 'legal' -> 'offerExpiry',
      'privacyPolicyUrl', p_payload -> 'legal' -> 'privacyPolicyUrl',
      'qrTermsConfirmed', p_payload -> 'legal' -> 'qrTermsConfirmed',
      'noRiderDataWithoutConsent', p_payload -> 'legal' -> 'noRiderDataWithoutConsent',
      'driverIsVehicleOwner', p_payload -> 'legal' -> 'driverIsVehicleOwner',
      'fullAuthorizationIssuedAt', p_payload -> 'legal' -> 'fullAuthorizationIssuedAt',
      'fullAuthorizationDelivery', p_payload -> 'legal' -> 'fullAuthorizationDelivery'
    )
  end;
$$;

-- --------------------------------------------------------- public_campaigns
--
-- A definer-owned view (security_invoker = false) so anonymous readers do not
-- need SELECT on the base table. It is deliberately narrow:
--
--   * only `approval_state = 'approved'`,
--   * no `owner` column (that is an account identifier),
--   * consent records reduced to booleans + "on file".
--
-- Because anon holds no privilege on public.campaigns, no future policy can
-- accidentally widen this: the view is the entire public surface.

create or replace view public.public_campaigns
with (security_invoker = false) as
select
  c.id,
  c.title,
  c.approval_state,
  c.compliance_mode,
  case
    when c.payload ? 'legal'
      then jsonb_set(c.payload, '{legal}', coalesce(public.redacted_legal(c.payload), 'null'::jsonb))
    else c.payload
  end as payload,
  c.updated_at
from public.campaigns c
where c.approval_state = 'approved';

comment on view public.public_campaigns is
  'The only anonymous read path for campaigns. Approved rows only, no owner column, consent records redacted to booleans. See 0006.';

revoke all on public.public_campaigns from public;
grant select on public.public_campaigns to anon, authenticated;

-- ------------------------------------------------------ pair code resolution
--
-- `booth_directory` exposed every booth (owner uuid, name, city, created_at and
-- both pair codes) to anyone holding the anon key, and the app queried it with
-- an `or=(pair_code.eq.…)` filter that made bulk enumeration trivial. A
-- six-character code is ~31 bits; it only works as a lookup key when lookups
-- are exact and rate limited, not when the table can be listed.
--
-- Replacement: one exact-match function, one row, two fields, no identity.
-- The rate limit lives in the BFF (20 lookups/minute per client) because SQL
-- policies cannot express "slow down".

drop view if exists public.booth_directory;

create or replace function public.resolve_pair_code(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_booth public.booths%rowtype;
begin
  if length(v_code) <> 6 then
    return jsonb_build_object('found', false);
  end if;

  select *
    into v_booth
    from public.booths b
   where b.pair_code = v_code
      or b.front_pair_code = v_code
   limit 1;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  -- No owner, no name, no city, no timestamps: confirming a code must not
  -- become a way to read another booth's details.
  return jsonb_build_object(
    'found', true,
    'position', case when v_booth.front_pair_code = v_code then 'front' else 'rear' end
  );
end;
$$;

revoke all on function public.resolve_pair_code(text) from public;
grant execute on function public.resolve_pair_code(text) to anon, authenticated;

comment on function public.resolve_pair_code(text) is
  'Exact-match pair code lookup for terminals. Returns {found, position} and nothing else.';

-- ------------------------------------------------------- proof-of-play rollup
--
-- The old view ran with the definer's rights over a publicly readable table, so
-- anyone could read per-campaign play counts. With security_invoker the view
-- returns only the rows the caller may already read (owners and reviewers), and
-- the BFF serves the same shape to the console over an authenticated session.

create or replace view public.campaign_play_counts
with (security_invoker = true) as
select
  e.campaign_id,
  count(*) filter (where e.kind = 'proof-of-play')      as plays,
  count(*) filter (where e.kind = 'qr-scan')             as scans,
  count(*) filter (where e.kind = 'referral-conversion') as conversions,
  max(e.at)                                              as last_event_at
from public.campaign_events e
group by e.campaign_id;

comment on view public.campaign_play_counts is
  'Aggregate proof-of-play per campaign. security_invoker: callers only ever count events they are allowed to read.';

revoke all on public.campaign_play_counts from anon;
grant select on public.campaign_play_counts to authenticated;
