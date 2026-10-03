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

## Phase 2 — Commercial Backend: **not built** (needs provider decisions)

Object storage · campaign database with approval workflow · signed URLs and a
signed playlist manifest · event API for proof-of-play/scans/conversions ·
realtime messaging service · client campaign portal.

The `assetUrl` seam is in place, so signed URLs drop in without touching the
display. The display already logs "Commercial campaign displayed" locally; that
record is what an event API would ship.

## Tests

42 tests in `src/lib/signage.test.ts` cover every rule above, including the exact
schedule boundaries, the 79.9/80 km/h dwell switch, unsafe asset URLs, brightness
floors and the playlist ordering. Total suite: **97 tests**.
