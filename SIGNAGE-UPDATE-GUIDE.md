# Manual update guide — Commercial Signage (COMMERCIAL-SIGNAGE-PLAN.md)

Apply these **6 file steps in order**. Step 2 must come before 3 and 4 (both
import from it). Each step ends with a check you can do in the browser/GitHub.

**Fastest path:** everything below is already applied on branch
`fix/core-bugs-and-tests`. Use `retroflex-fixed-source.zip` (drag the files into
GitHub's web uploader) or apply the patches (`git am`). This guide exists so you
can also do it by hand, file by file, and understand each change.

| Step | File | Type | Lines |
| --- | --- | --- | --- |
| 1 | `src/types.ts` | modify (1 block) | +10 |
| 2 | `src/lib/signage.ts` | **create** | 397 |
| 3 | `src/lib/signage.test.ts` | **create** | 334 |
| 4 | `src/components/DisplayScreen.tsx` | modify (11 hunks) | +120 / −36 |
| 5 | `src/components/DriverConsole.tsx` | modify (5 hunks) | +39 / −4 |
| 6 | `src/lib/signage.test.ts` + verify | run | — |

---

## Step 1 — `src/types.ts`: campaign record fields

Find the `CommercialCampaign` interface and replace its top block:

**FIND**
```ts
export interface CommercialCampaign {
  id: string;
  title: string;
  enabled: boolean;
  approved: boolean;
  assetDataUrl: string;
  /** "gif" is only allowed when NSW safety mode is off. */
  mediaType: "image" | "video" | "gif";
```

**REPLACE WITH**
```ts
export interface CommercialCampaign {
  id: string;
  title: string;
  enabled: boolean;
  approved: boolean;
  /** Cached pilot asset (data URL). Optional when an approved assetUrl is set. */
  assetDataUrl?: string;
  /** Approved remote asset — signed URL in the Phase 2 backend. */
  assetUrl?: string;
  /** Where a scan/click should land. Never shown as a QR under NSW Safety Mode. */
  landingUrl?: string;
  /** Schedule window (epoch ms). Undefined = always eligible. */
  startAt?: number;
  endAt?: number;
  /** Per-campaign brightness ceiling (percent, 18-100). */
  brightnessCap?: number;
  /** "gif" is only allowed when NSW safety mode is off. */
  mediaType: "image" | "video" | "gif";
```

**Check:** `npx tsc --noEmit` still reports 0 errors (nothing reads those fields yet).

---

## Step 2 — create `src/lib/signage.ts` (the engine)

New file, 397 lines. **Full content is in the zip at `src/lib/signage.ts`** — copy
it verbatim (GitHub → *Add file → Create new file → path `src/lib/signage.ts`).

It exports, all pure and unit-tested:

| Export | Purpose |
| --- | --- |
| `NSW_MIN_DWELL_SECONDS` (10), `NSW_MIN_DWELL_HIGH_SPEED_SECONDS` (25), `NSW_HIGH_SPEED_KPH` (80), `NSW_NIGHT_BRIGHTNESS_CAP` (62), `MIN_DISPLAY_BRIGHTNESS` (18) | The plan's numeric rules in one place |
| `minDwellSeconds(speedKph)` | 10s below 80 km/h, 25s at/above |
| `campaignDwellSeconds(campaign, {nswSafetyMode, speedKph})` | Author value raised to the legal floor in safety mode |
| `campaignScheduleState(campaign, now)` | `unscheduled \| scheduled \| live \| expired` |
| `campaignAssetSrc(campaign)`, `isSafeAssetUrl(url)`, `effectiveMediaType(campaign, nsw)` | Asset resolution; rejects `javascript:`/`blob:`; downgrades media to static in safety mode |
| `campaignBlockReasons(campaign, context)` | **Why** a campaign can't show (disabled, unapproved, wrong screen, out of window, legal-incomplete, parked-confirmation-missing, media-not-static, asset-missing, referral-incomplete) |
| `campaignIsEligible`, `selectCampaigns(list, context)` | Eligibility + filtering |
| `campaignComplianceIssues`, `campaignIsComplianceReady`, `campaignConsentIssues`, `campaignReferralIssues` | The six signed consents + referral terms |
| `buildPlaylist({platforms, campaigns, commercialEnabled, nswSafetyMode, includeBlank})` | Plan order: logo → blank → campaign → blank, blank runs collapsed |
| `slideDurationSeconds(slide, options)` | Per-slide timing including the dwell floor |
| `campaignBrightness(base, {campaign, isNight})` | Per-campaign cap + night cap, never below the readable floor, never raises |
| `campaignScheduleLabel(campaign, now)` | Human label for the console |
| `campaignDraftIssues(draft)` | Console validation before save |

**Check:** the file has no imports except `import type { CommercialCampaign, DeviceProfile } from "../types";`.

---

## Step 3 — create `src/lib/signage.test.ts` (42 tests)

New file, 334 lines, **full content in the zip**. It imports `blankLegalFixture`
from `../test/fixtures`, which already exists. Copy verbatim.

**Check before moving on:**
```bash
npx vitest run src/lib/signage.test.ts     # 42 passed
```

---

## Step 4 — `src/components/DisplayScreen.tsx` (11 hunks)

### 4a. Imports — add the engine

**FIND**
```ts
import { PLATFORMS, getPlatform } from "../lib/platforms";
```
**REPLACE WITH**
```ts
import { PLATFORMS, getPlatform } from "../lib/platforms";
import {
  buildPlaylist,
  campaignBrightness,
  campaignAssetSrc,
  isSafeAssetUrl,
  effectiveMediaType,
  selectCampaigns,
  slideDurationSeconds,
} from "../lib/signage";
```

### 4b. New state — the active campaign's brightness cap

**FIND**
```ts
  const [taps, setTaps] = useState(0);
```
**REPLACE WITH**
```ts
  const [taps, setTaps] = useState(0);
  // null = the current slide is not a campaign, so no extra brightness cap applies.
  const [activeBrightnessCap, setActiveBrightnessCap] = useState<number | null>(null);
```

### 4c. Campaign selection → engine (schedule + safety + asset + consents)

**FIND**
```ts
  const campaigns = (settings.commercialCampaigns ?? []).filter((campaign) => campaignIds.includes(campaign.id) && (campaign.target ?? "both") !== (position === "front" ? "rear" : "front") && campaignIsComplianceReady(campaign) && (!(settings.nswSafetyMode ?? true) || !!deviceProfile?.commercialParkedConfirmed));
```
**REPLACE WITH**
```ts
  // Only campaigns assigned to this device, inside their schedule window, with a
  // usable asset and complete consents. The engine reports *why* one is blocked.
  const campaigns = selectCampaigns(
    (settings.commercialCampaigns ?? []).filter((campaign) => campaignIds.includes(campaign.id)),
    {
      nswSafetyMode: settings.nswSafetyMode ?? true,
      position,
      parkedConfirmed: deviceProfile?.commercialParkedConfirmed,
    },
  );
```

### 4d. Brightness — apply the cap

**FIND**
```ts
  const brightness = Math.max(18, daylightBrightness * batteryFactor) / 100;
```
**REPLACE WITH**
```ts
  const baseBrightness = Math.max(18, daylightBrightness * batteryFactor);
  // A campaign may lower brightness further (plan: day/night + per-campaign caps).
  const brightness = campaignBrightness(baseBrightness, {
    campaign: activeBrightnessCap === null ? undefined : { brightnessCap: activeBrightnessCap },
    isNight: !daylight,
  }) / 100;
```

### 4e. Playlist event — carry the cap up

**FIND**
```ts
  const handlePlaylistEvent = useCallback((event: { kind: "platform" | "campaign" | "blank"; title: string; id?: string }) => {
    setActiveContent(event.title);
```
**REPLACE WITH**
```ts
  const handlePlaylistEvent = useCallback((event: { kind: "platform" | "campaign" | "blank"; title: string; id?: string; brightnessCap?: number }) => {
    setActiveContent(event.title);
    // null = no campaign on screen, so no extra cap applies.
    setActiveBrightnessCap(event.kind === "campaign" ? (event.brightnessCap ?? 100) : null);
```

### 4f. Pass the current speed into the playlist

**FIND**
```ts
          blankDurationSeconds={deviceProfile?.blankDurationSeconds ?? settings.blankDurationSeconds ?? 1.5}
        />
```
**REPLACE WITH**
```ts
          blankDurationSeconds={deviceProfile?.blankDurationSeconds ?? settings.blankDurationSeconds ?? 1.5}
          speedKph={motion.isStationary ? 0 : (motion.speedMps ?? 0) * 3.6}
        />
```

### 4g. `AppsFace` props — accept speed and the wider event

**FIND**
```ts
  onActiveItem: (event: { kind: "platform" | "campaign" | "blank"; title: string; id?: string }) => void;
```
**REPLACE WITH**
```ts
  onActiveItem: (event: { kind: "platform" | "campaign" | "blank"; title: string; id?: string; brightnessCap?: number }) => void;
```

**FIND**
```ts
  passengerName?: string;
  displayDurationSeconds: number;
  includeBlank: boolean;
  blankDurationSeconds: number;
}) {
```
**REPLACE WITH**
```ts
  passengerName?: string;
  displayDurationSeconds: number;
  includeBlank: boolean;
  blankDurationSeconds: number;
  /** Current speed, used for the NSW dwell floor. */
  speedKph?: number;
}) {
```

**FIND**
```ts
  displayDurationSeconds,
  includeBlank,
  blankDurationSeconds,
}: {
  apps: string[];
```
**REPLACE WITH**
```ts
  displayDurationSeconds,
  includeBlank,
  blankDurationSeconds,
  speedKph = 0,
}: {
  apps: string[];
```

### 4h. Playlist construction → engine

**FIND**
```ts
  const campaignItems = commercialEnabled
    ? campaigns
        .filter((campaign) => campaign.enabled && campaign.approved)
        .filter((campaign) => !nswSafetyMode || campaign.mediaType === "image")
        .map((campaign) => ({ kind: "campaign" as const, campaign }))
    : [];
  const platformItems = visible.map((platform) => ({ kind: "platform" as const, platform }));
  const playlist = includeBlank ? [...platformItems, ...campaignItems, null] : [...platformItems, ...campaignItems];
  const active = playlist[index % Math.max(playlist.length, 1)];
```
**REPLACE WITH**
```ts
  // Plan order: platform logo → blank → campaign → blank (blanks are the
  // OLED-black low-power intervals and collapse when there is nothing between them).
  const playlist = useMemo(
    () =>
      buildPlaylist({
        platforms: visible,
        campaigns,
        commercialEnabled,
        nswSafetyMode,
        includeBlank,
      }),
    [appKey, campaigns, commercialEnabled, nswSafetyMode, includeBlank],
  );
  const active = playlist[index % Math.max(playlist.length, 1)];
```

### 4i. Active-item reporting — include the cap

**FIND**
```ts
      onActiveItem({ kind: "campaign", title: active.campaign.title, id: active.campaign.id });
      return;
    }
    onActiveItem({ kind: "platform", title: active.platform.name, id: active.platform.id });
```
**REPLACE WITH**
```ts
      onActiveItem({
        kind: "campaign",
        title: active.campaign.title,
        id: active.campaign.id,
        brightnessCap: active.campaign.brightnessCap,
      });
      return;
    }
    onActiveItem({
      kind: "platform",
      title: active.kind === "platform" ? active.platform.name : "",
      id: active.kind === "platform" ? active.platform.id : undefined,
    });
```

### 4j. Slide timing → engine (legal dwell)

**FIND**
```ts
    const duration = active?.kind === "campaign"
      ? (nswSafetyMode ? Math.max(10, active.campaign.displaySeconds) : active.campaign.displaySeconds)
      : active ? displayDurationSeconds : blankDurationSeconds;
    const id = window.setTimeout(() => setIndex((current) => (current + 1) % playlist.length), Math.max(0.5, duration) * 1000);
    return () => window.clearTimeout(id);
  }, [index, appKey, includeBlank, playlist.length, !!active, displayDurationSeconds, blankDurationSeconds]);
```
**REPLACE WITH**
```ts
    const duration = slideDurationSeconds(active, {
      platformSeconds: displayDurationSeconds,
      blankSeconds: blankDurationSeconds,
      nswSafetyMode,
      speedKph,
    });
    const id = window.setTimeout(() => setIndex((current) => (current + 1) % playlist.length), duration * 1000);
    return () => window.clearTimeout(id);
  }, [index, appKey, includeBlank, playlist.length, !!active, displayDurationSeconds, blankDurationSeconds, nswSafetyMode, speedKph]);
```

### 4k. Render + the black failure frame

**FIND**
```ts
  if (!active) return <div className="h-full w-full bg-black" />;
```
**REPLACE WITH**
```ts
  if (!active || active.kind === "blank") return <div className="h-full w-full bg-black" />;
```

Then replace the whole `CampaignSlide` function with:

```tsx
function CampaignSlide({ campaign, nswSafetyMode, fade }: { campaign: CommercialCampaign; nswSafetyMode: boolean; fade: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = campaignAssetSrc(campaign);
  const media = effectiveMediaType(campaign, nswSafetyMode);

  // Plan: "a black default image on failure". A campaign with no usable asset,
  // a rejected asset URL or a failed load renders the black frame instead of a
  // browser error icon.
  if (!src || !isSafeAssetUrl(src) || failed) {
    return <div role="img" aria-label={`${campaign.title} unavailable`} className="h-full w-full bg-black" />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {media === "image" || media === "gif" ? (
        <img
          src={src}
          alt={campaign.title}
          onError={() => setFailed(true)}
          className={`h-full w-full object-cover ${fade ? "animate-display-fade" : ""}`}
        />
      ) : (
        <video src={src} onError={() => setFailed(true)} className={`h-full w-full object-cover ${fade ? "animate-display-fade" : ""}`} muted autoPlay loop playsInline />
      )}
      {!nswSafetyMode && (campaign.discountText || campaign.referralCode) && (
        <div className="absolute inset-x-0 bottom-0 bg-black/65 px-[4vw] py-[2vh] text-center text-cream">
          {campaign.discountText && <p className="font-cond text-[4vh] font-bold">{campaign.discountText}</p>}
          {campaign.referralCode && <p className="mt-1 text-[2vh] tracking-[0.24em]">CODE {campaign.referralCode}</p>}
        </div>
      )}
    </div>
  );
}
```

Finally **delete** the old local helper (it now lives in the engine):

**DELETE**
```ts
function campaignIsComplianceReady(campaign: CommercialCampaign) {
  const legal = campaign.legal;
  if (!legal) return false;
  const consents = [legal.appOwner, legal.driver, legal.vehicleOwner, legal.campaignOwner, legal.trademarkAuthorization, legal.safetyAssessment];
  const consentReady = consents.every((consent) => consent.confirmed && consent.signerName.trim() && consent.agreementReference.trim());
  const referralReady = !campaign.referralCode || Boolean((legal.merchantName ?? "").trim() && legal.offerExpiry && legal.privacyPolicyUrl && legal.qrTermsConfirmed && legal.noRiderDataWithoutConsent);
  return consentReady && referralReady;
}
```

**Check:** `npx tsc --noEmit` → 0 errors.

---

## Step 5 — `src/components/DriverConsole.tsx` (5 hunks)

### 5a. Import

**FIND**
```ts
import { createConsentPdf, deliverAgreementPdf } from "../lib/agreements";
```
**REPLACE WITH**
```ts
import { createConsentPdf, deliverAgreementPdf } from "../lib/agreements";
import { campaignDraftIssues, campaignScheduleLabel } from "../lib/signage";
```

### 5b. New draft state

**FIND**
```ts
  const [campaignTarget, setCampaignTarget] = useState<"both" | "rear" | "front">("both");
```
**REPLACE WITH**
```ts
  const [campaignTarget, setCampaignTarget] = useState<"both" | "rear" | "front">("both");
  // Phase 1 plan fields: approved remote asset, landing URL, schedule window, brightness cap.
  const [assetUrl, setAssetUrl] = useState("");
  const [landingUrl, setLandingUrl] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [brightnessCap, setBrightnessCap] = useState(100);
```

### 5c. Validation before save

In `addCampaign`, immediately after the existing `campaignLegalIssues` check, insert:

```ts
    const draftIssues = campaignDraftIssues({
      title,
      assetDataUrl,
      assetUrl,
      landingUrl,
      startAt: startAt ? new Date(startAt).getTime() : undefined,
      endAt: endAt ? new Date(endAt).getTime() : undefined,
      brightnessCap,
      mediaType,
      nswSafetyMode: nswSafety,
    });
    if (draftIssues.length) {
      setCampaignError(draftIssues[0]);
      return;
    }
```

### 5d. Saved campaign object

**FIND**
```ts
      mediaType,
      assetDataUrl,
      discountText: nswSafety ? undefined : discountText.trim() || undefined,
```
**REPLACE WITH**
```ts
      mediaType,
      assetDataUrl: assetDataUrl || undefined,
      assetUrl: assetUrl.trim() || undefined,
      landingUrl: landingUrl.trim() || undefined,
      startAt: startAt ? new Date(startAt).getTime() : undefined,
      endAt: endAt ? new Date(endAt).getTime() : undefined,
      brightnessCap: brightnessCap < 100 ? brightnessCap : undefined,
      discountText: nswSafety ? undefined : discountText.trim() || undefined,
```

### 5e. Editor inputs

**FIND**
```tsx
          <label className="block text-xs">Campaign dwell · {displaySeconds.toFixed(1)} sec
```
…and immediately **after** that whole `<label>…</label>` element, insert:

```tsx
          {nswSafety && <p className="text-[10px] text-mist">NSW Safety Mode raises dwell to a 10s minimum (25s at 80 km/h or above).</p>}
          <input value={assetUrl} onChange={(event) => setAssetUrl(event.target.value)} placeholder="Approved asset URL (https:// or leave blank for the uploaded file)" className="w-full rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-amber" />
          <input value={landingUrl} onChange={(event) => setLandingUrl(event.target.value)} placeholder="Landing URL for the offer (https://...)" className="w-full rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-amber" />
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[10px] text-mist">Starts (optional)<input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} className="mt-1 w-full rounded-xl border border-line bg-ink px-3 py-2 text-xs text-cream outline-none focus:border-amber" /></label>
            <label className="block text-[10px] text-mist">Ends (optional)<input type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.target.value)} className="mt-1 w-full rounded-xl border border-line bg-ink px-3 py-2 text-xs text-cream outline-none focus:border-amber" /></label>
          </div>
          <label className="block text-xs">Brightness cap · {brightnessCap}%<input type="range" min={18} max={100} step={1} value={brightnessCap} onChange={(event) => setBrightnessCap(Number(event.target.value))} className="mt-2 w-full" /></label>
```

### 5f. Campaign list — schedule status

**FIND**
```tsx
{campaign.title} · {campaign.target ?? "both"} · {campaign.mediaType} · {campaign.displaySeconds}s</span>
```
**REPLACE WITH**
```tsx
{campaign.title} · {campaign.target ?? "both"} · {campaign.mediaType} · {campaign.displaySeconds}s · {campaignScheduleLabel(campaign)} · cap {campaign.brightnessCap ?? 100}%</span>
```

**Check:** `npx tsc --noEmit` → 0 errors.

---

## Step 6 — verify the whole thing

```bash
npm run verify
```

Expected:
```
Test Files  8 passed (8)
     Tests  97 passed (97)
smoke: PASSED — single-file bundle, artifact checks clean
```

Then in the running app:

1. `#/login` → `driver@retroflex.app` / `demo1234` → Settings → Enterprise Lab.
2. Upload a static image, fill the six consents, set a **landing URL** and a
   **brightness cap** of e.g. 40%, save. The campaign row should read
   `… · Always eligible · cap 40%`.
3. Tick **Parked confirmation for campaigns** on the device group and set
   **Campaign media** to the campaign.
4. `#/lab` → the rear pane should cycle `logo → black → campaign → black`, and
   while the campaign is up the whole pane dims to the 40% cap.
5. Set **NSW Safety Mode** on with a 3-second dwell → the campaign dwell must
   come back to 10s (25s above 80 km/h) — check with a stopwatch or the log.
6. Delete the asset file the campaign points at (or use a bad URL) → the pane
   shows a **black frame**, not a broken-image icon.
7. Add a schedule window starting tomorrow → the campaign disappears from the
   playlist and the row reads `Scheduled from …`.

---

## What this does NOT include (Phase 2, on purpose)

Phase 2 of the plan is a backend, and building the wrong one would be wasted
work. Nothing here fakes it. Still open:

| Phase 2 item | Status | What it needs from you |
| --- | --- | --- |
| Object storage for assets | not built | Pick a provider (Supabase Storage, S3/R2) |
| Campaign DB + approval workflow | not built | Supabase/Firebase project + schema |
| Signed asset URLs + signed playlist manifest | **seam ready** | `assetUrl` already preferred over the cached file; swap in signed URLs |
| Event API (proof-of-play, scans, conversions) | partly local | Display already logs "Commercial campaign displayed" to the device log — point it at an endpoint |
| Realtime messaging (replace best-effort PeerJS) | not built | Choose Supabase Realtime / Ably / Firebase |
| Client campaign portal | not built | Scope with the campaign owners |

Tell me which provider you want and I'll build Phase 2 on the same branch.
