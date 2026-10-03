# Commercial Signage — Phase 2 (Commercial Backend)

Implements Phase 2 of `COMMERCIAL-SIGNAGE-PLAN.md`. The app talks to a
**provider-agnostic backend layer**:

| Adapter | When it runs | What it is |
| --- | --- | --- |
| `src/lib/backend/local.ts` | default, always works | On-device storage + in-process + cross-tab notifications. No config, no network. |
| `src/lib/backend/supabase.ts` | when Supabase env vars are set | Postgres + Storage + polling realtime, over REST (no SDK dependency). |

Both satisfy the same `Backend` interface, so **no component changes** when you
switch. Nothing in the UI imports a provider directly.

## Phase 2 checklist

| Plan item | Status | Where |
| --- | --- | --- |
| Object storage for images, GIFs and video | ✅ | `AssetStore.put/signedUrl/remove`; Supabase bucket + policies in the migration |
| Campaign database with start/end dates, geographic rules and approval state | ✅ | `campaigns` table; `geoRule` + `approval` on the campaign record; schedule already in Phase 1 |
| Signed asset URLs | ✅ | `AssetStore.signedUrl()` (Supabase `object/sign`) |
| Signed playlist manifest | ✅ | `manifest.ts` — HMAC-SHA256 over a canonical serialisation, verify constant-time |
| Event API for proof-of-play, QR scans, referral conversions | ✅ | `EventQueue` + `campaign_events` table + `campaign_play_counts` view |
| Admin approval workflow | ✅ | `setApproval()` + `approval_audit` table + console panel |
| Client campaign portal | ✅ (in-app) | `SignageBackendPanel` shows approvals, schedule, caps and per-campaign play counts |
| Realtime messaging | ✅ (polling) | `subscribe()` contract; Supabase polling adapter plus published `campaigns` table for websocket upgrade |

## Enabling the Supabase backend

**1. Create the schema.** Supabase dashboard → SQL Editor → paste
`supabase/migrations/0001_signage_phase2.sql` → Run. It creates the tables,
indexes, RLS policies, a trigger that **refuses to approve a campaign whose six
consents aren't signed**, the `campaigns` storage bucket with policies, and the
play-count view.

**2. Set the environment variables** (Vercel → Settings → Environment Variables,
and `.env.local` for local dev):

```
VITE_BACKEND=supabase
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_SUPABASE_BUCKET=campaigns
# Optional: signing secret for manifest VERIFICATION (verify-only in the browser)
VITE_SUPABASE_MANIFEST_KEY=<random 32+ chars>
VITE_SUPABASE_MANIFEST_KEY_ID=rf-2026-01
```

**3. Redeploy.** The console's *Commercial backend* panel switches from
`On-device (local)` to `Supabase (shared)` and starts showing shared campaigns,
the approval queue and the event feed.

Without those variables the app runs entirely on the local adapter — which is
why nothing here can break your current deployment.

## Security model

- **The anon key is public.** Policies, not the key, protect the data.
- Displays may **read approved campaigns** and **insert events**; only
  authenticated users may write campaigns or approve them.
- Events are **insert-only** — no update or delete policy exists, so the
  proof-of-play trail is append-only.
- Approval is enforced **in the database**, not just the UI: the
  `enforce_campaign_approval` trigger raises if a campaign is approved with the
  six consents incomplete.
- The manifest signing secret never ships to the browser in production. The
  browser only verifies; signing belongs in an Edge Function (below).

## Reliability notes

- The display can lose signal mid-trip: `EventQueue` batches, retries with a
  capped attempt count, and drops only what has exhausted retries (counted in
  `stats.dropped`). The queue is capped at 500 events.
- Realtime is **polling** (`subscribe({ pollMs })`) so the single-file bundle
  needs no websocket client. `campaigns` is added to the `supabase_realtime`
  publication, so switching to websocket `postgres_changes` later is an adapter
  change only — the `subscribe()` contract stays.

## Not built yet (deliberately)

| Item | Why |
| --- | --- |
| Supabase Edge Function that **signs** manifests | Needs your project's service-role key; the verify side is done and tested. Sketch below. |
| QR scan capture | The plan excludes driver-facing QR under NSW Safety Mode; the event kind exists and is tested, waiting on an approved scan surface. |
| Client-facing portal **outside** the app | Needs an auth/account decision (Supabase Auth vs. invite links). The in-app view is live today. |

### Manifest signing function (when you want it)

```ts
// supabase/functions/manifest/index.ts
import { createHmac } from "node:crypto";

Deno.serve(async (req) => {
  const { campaigns } = await req.json();
  const version = 2;
  const issuedAt = Date.now();
  const entries = campaigns; // already filtered/sorted by the caller
  const payload = JSON.stringify({ version, issuedAt, entries });
  const signature = createHmac("sha256", Deno.env.get("MANIFEST_SECRET")!)
    .update(payload)
    .digest("hex");
  return Response.json({ version, issuedAt, entries, algorithm: "HMAC-SHA256", signature });
});
```

`verifyManifest()` in `src/lib/backend/manifest.ts` already validates exactly that
format, so the display will accept it unchanged.

## Tests

`src/lib/backend/manifest.test.ts` (17) · `src/lib/backend/backend.test.ts` (31) ·
`src/lib/signage.test.ts` (51 incl. approval + geo rules).

Notable cases: tampering with a manifest entry invalidates the signature · an
unsigned manifest is rejected when a secret is configured · a failed event send
keeps the batch for retry · the queue never grows past its cap · events are
insert-only in the schema · geo rules fail closed when there is no GPS fix.
