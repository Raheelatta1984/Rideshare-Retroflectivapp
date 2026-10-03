# Commercial Signage — implementation status

What this branch actually implements from `COMMERCIAL-SIGNAGE-PLAN.md`, and what
is deliberately left for Phase 2. Step-by-step manual apply instructions are in
**[SIGNAGE-UPDATE-GUIDE.md](./SIGNAGE-UPDATE-GUIDE.md)**.

## Phase 1 — Safe Local Pilot: **built**

Campaign record (plan §Phase 1) → `CommercialCampaign` in `src/types.ts`:

| Plan field | Status |
| --- | --- |
| `campaignId` | ✅ `id` |
| `title` | ✅ |
| `mediaType: image \| gif \| video` | ✅ |
| `assetUrl` | ✅ **new** — preferred over the cached copy |
| `landingUrl` | ✅ **new** — validated http(s) |
| `referralCode` | ✅ (excluded from the safety-mode playlist) |
| `startAt` / `endAt` | ✅ **new** — schedule window |
| `displaySeconds` | ✅ |
| `brightnessCap` | ✅ **new** |
| `enabled` | ✅ (plus existing `approved` + six-consent legal block) |

Playlist model (plan): **logo → blank → campaign → blank**, with blanks collapsed
when nothing sits between them, and campaign slides dropped entirely unless the
device profile has commercial access. See `buildPlaylist()` in `src/lib/signage.ts`.

NSW Safety Mode enforcement (plan §Phase 1):

| Rule | Where | Test |
| --- | --- | --- |
| Static image only, GIF/video rejected | `effectiveMediaType`, eligibility `media-not-static`, `campaignDraftIssues` | ✅ |
| 10 s minimum dwell | `campaignDwellSeconds` | ✅ |
| 25 s dwell at 80 km/h or above | `minDwellSeconds` | ✅ |
| No QR/referral overlay | overlay rendered only when `!nswSafetyMode`; referral terms required for eligibility | ✅ |
| Black blank/failure frame | `CampaignSlide` black frame on missing, rejected or failed asset | ✅ |
| Parked confirmation per device | eligibility `parked-confirmation-missing` | ✅ |
| Day/night brightness cap | `campaignBrightness` (`NSW_NIGHT_BRIGHTNESS_CAP = 62`) | ✅ |
| Per-campaign brightness cap | `campaignBrightness` | ✅ |
| Six signed consents before display | `campaignConsentIssues` | ✅ |

Extra guardrails added beyond the plan text: asset URLs must be `https://` or an
image/video data URI (`javascript:` and `blob:` are refused), brightness can only
ever be lowered, and every block reason is reported instead of a silent no-show.

## Phase 2 — Commercial Backend: **built and deployed**

Commits `4e33c88` and `79c66de`. Provider-agnostic backend in `src/lib/backend/`
(one `Backend` contract, an on-device adapter and a Supabase adapter over plain
`fetch` — no SDK), signed playlist manifest, event queue with retries, the SQL
migration, the approval queue and the client-facing play counts. Setup and the
security model are in `PHASE-2.md`.

| Plan item | Status |
| --- | --- |
| Object storage for images, GIFs, video | ✅ `AssetStore` + `campaigns` bucket policies |
| Campaign database, dates, geography, approval state | ✅ `campaigns.payload` + `approval_state` + `compliance_mode` |
| Signed asset URLs | ✅ `assets.signedUrl()` |
| Signed playlist manifest | ✅ HMAC-SHA256, verify-only in the browser |
| Event API (proof-of-play, scans, conversions) | ✅ `EventQueue` + `campaign_events` + `campaign_play_counts` |
| Approval workflow | ✅ console queue + `approval_audit`, enforced by a DB trigger |
| Realtime | ✅ polling now; `campaigns` published for a websocket upgrade |
| Client portal | ✅ in-app panel (per-campaign plays, approval state) |

### Legal & approval pack master switch

A second switch beside NSW Safety Mode turns the whole legal pack on or off —
consent records, agreements, trademark authorization, the written permission
register, the authorization PDFs, campaign approval, referral terms and
geographic gating. With it off, campaigns display without any of that, are
stamped `complianceMode: "unregulated"`, and keep displaying after the pack is
switched back on (test content, marked on the glass and in the console).

NSW Safety Mode is deliberately **separate** and still applies to unregulated
content: static media only, the dwell floor, parked confirmation, the night
brightness cap. The database guard is not relaxed either — unregulated content
is mirrored as a draft, never as an approval. Migration `0002_compliance_mode.sql`
adds the column and the reporting hook.

## Tests

The suite is **180 tests across 12 files** and runs with `npm run verify`
(typecheck, vitest, then a production build with artifact smoke checks).
`src/lib/signage.test.ts` covers every safety rule including the schedule
boundaries, the 79.9/80 km/h dwell switch, unsafe asset URLs, brightness floors,
playlist ordering, and both states of the legal pack switch.
