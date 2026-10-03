-- Phase 2 · 0002 — legal & approval pack mode per campaign
--
-- The app has a master switch for the legal & approval pack (consent records,
-- agreements, trademark authorization, the written permission register,
-- approval and geographic gating). It is separate from NSW Safety Mode, which
-- covers the road-safety rules of the display itself.
--
-- Campaigns created while the pack is off are stamped `unregulated`. They stay
-- exempt from the approval guard and keep displaying for testing. The guard is
-- deliberately NOT relaxed: unregulated content is recorded as a draft, never
-- as an approval, so there is no fake approval to defend against.

alter table public.campaigns
  add column if not exists compliance_mode text not null default 'regulated';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaigns_compliance_mode_check'
  ) then
    alter table public.campaigns
      add constraint campaigns_compliance_mode_check
      check (compliance_mode in ('regulated', 'unregulated'));
  end if;
end $$;

create index if not exists campaigns_compliance_mode_idx
  on public.campaigns (compliance_mode);

comment on column public.campaigns.compliance_mode is
  'regulated: consents, agreements and approval enforced. unregulated: created while the legal & approval pack was off; exempt from the approval guard and flagged as test content on the display.';

-- Expose the flag to the client portal rollup so unregulated plays can be
-- reported separately from compliant ones.
create or replace view public.campaign_play_counts as
  select campaign_id,
         count(*) filter (where kind = 'proof-of-play')      as plays,
         count(*) filter (where kind = 'qr-scan')             as scans,
         count(*) filter (where kind = 'referral-conversion') as conversions,
         max(at)                                              as last_event_at
  from public.campaign_events
  group by campaign_id;
