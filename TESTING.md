# Retroflex — testing guide

## Quick start

```bash
npm ci
npm run verify        # everything: typecheck + tests + build + artifact checks
```

Individual steps:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` — type errors fail the run |
| `npm test` | Vitest, single pass (55 tests) |
| `npm run test:watch` | Re-run on save while you work |
| `npm run test:coverage` | Coverage report (`text`, `html`, `json-summary`) |
| `npm run build` | Production single-file bundle into `dist/` |
| `npm run smoke` | Checks the built artifact (see below) — run after `build` |
| `npm run verify` | All of the above in order, CI does the same |

CI: `.github/workflows/ci.yml` runs `typecheck → test → build → smoke` on every
push to `main` and every pull request.

## What the automated tests cover

| File | Covers |
| --- | --- |
| `src/lib/id.test.ts` | `uid()` keeps its prefix and stays unique, pair-code format/validation, `peerId()` determinism per role, `packetId()` shape, log tags |
| `src/lib/devices.test.ts` | profile id uniqueness (per device **and** per position), `createDeviceProfile()` default materialisation, `profileForDevice()` precedence (exact device → pair code → none) |
| `src/lib/sync.test.ts` | claims the deterministic host/display id, **dials** the other side on open, accepts inbound connections, acks packets, `peer-unavailable` retries quietly, `unavailable-id` falls back to a suffixed id, no relay traffic when unconfigured, no TURN credential in the bundle |
| `src/lib/storage.test.ts` | settings round-trip per driver, activity log ordering/cap, device-filtered tablet log, ride upsert |
| `src/lib/agreements.test.ts` | consent PDF from both input shapes, `deliverAgreementPdf()` returns a **string** status (never an object), `getPlatform()` total fallback |
| `src/lib/retroflex-core.test.ts` | pair-code sanitising, position normalising, hash-path normalising |
| `src/app.boot.test.tsx` | mounts the real `App` in jsdom on two routes, asserts no console errors, asserts boot-written record ids are unique and well-formed |

`npm run smoke` is separate: jsdom cannot execute the ES-module bundle, so it
checks the **artifact** instead — no CRA-style `process.env`, no dead relay host,
no leaked TURN password, no `\( {...} \)` corruption markers, bundle not
truncated, PWA manifest present, source zip emitted.

## Manual QA — the deployed app

Run against https://rideshare-retroflectivapp.vercel.app (or your local dev
server). Ticks are what a passing run looks like.

### A. Boot & routing
1. Open the site → landing page renders with the Retroflex hero. **No blank screen, no console errors.**
2. `#/lab` → phone + tablet side by side. `#/review` → checklist. `#/demo` → cinematic pickup.
3. Reload on a deep link (`#/display/7K2M9Q`) → the route survives the reload.

### B. Pairing — same browser (BroadcastChannel)
1. `#/lab`, pair code `7K2M9Q`: flip the big switch.
2. Right pane (tablet) wakes and shows the same platform apps as the phone.
3. Change **Auto brightness** or **Logo seconds** on the phone → the tablet pane reflects it within a second.

### C. Pairing — two devices (PeerJS)
1. Phone: `#/login` → `driver@retroflex.app` / `demo1234` → Driver Console → note the pair code.
2. Tablet: open `https://…/?mode=tablet&display=<CODE>` in landscape → "I authorize display control".
3. Console on both sides should log `Peer opened: retroflex-<CODE>-…` then `Peer connected: retroflex-<CODE>-…`.
4. Kill the tablet's network for 10 s → reconnect → the connection re-establishes without reloading.
5. If it does **not** connect: check for `peer-unavailable` (tablet not on yet — expected, it retries) vs a WebSocket failure (corporate/hotel network — needs TURN, set `VITE_TURN_*`).

### D. Motion gate & beacon timing
1. Enable the motion safety gate; the rear pane stays blank while "moving" and unlocks when "stopped".
2. Confirm the stop delay against **your intended value** — `stopDelaySeconds` defaults to 30 s (see BUG-REPORT §7.1).

### E. Driver console
1. Live tab: master switch, per-device groups, app toggles, brightness/logo sliders → each change persists across reload.
2. History tab: ride list renders **even for an unrecognised platform id** (previously crashed).
3. Settings → Fleet pair: add a 6-character code, it appears as a device group.
4. Settings → battery alerts: toggle + step + cooldown persist.

### F. Commercial campaigns & consent PDFs
1. Upload a campaign image, fill the legal block, issue a consent PDF.
2. After issuing, the legal panel still renders and shows `Signed … · delivery …` as **text** (previously blanked the panel).
3. With NSW Safety Mode on: GIF/video is rejected, and the campaign only appears on a device with "Parked confirmation" ticked.

### G. Owner source vault
1. Log in as the owner account → Booth → Owner Source Vault → source zip downloads.
2. A non-owner account sees the "available only to the owner" message.

### H. Regression spot-checks (the bugs fixed here)
| Check | Pass condition |
| --- | --- |
| Any id shown in the UI (`Device xxxx`, log ids) | Never contains `{`, `\(`, `\)` |
| Two tablets on the same phone | Get **separate** device groups, settings do not bleed |
| Front + rear on one pair code | Two separate profiles; front changes don't alter rear |
| Network tab | No requests to `relay.retroflex.app` |
| Console | No "Objects are not valid as a React child" |

## Adding tests

- Unit tests live next to the module (`src/lib/foo.test.ts`).
- Component/boot tests live in `src/**/*.test.tsx`; jsdom and jest-dom matchers are pre-configured in `src/test/setup.ts`.
- PeerJS is mocked in `src/lib/sync.test.ts` with a fake `Peer` class — copy that pattern for anything touching the sync layer.
- Shared fixtures go in `src/test/fixtures.ts`.

## Testing the commercial signage

### Accounts

Stored settings are repaired on read (`normalizeDeviceProfile`, plus a settings
merge over defaults in `getSettings`). Records written by an older build used to
crash the console render — the whole app went blank and nothing responded. If a
screen ever does fail to render, an error boundary now shows a recovery page with
**Reload** and **Clear local data & reload** instead of a dead black screen.

### Accounts

| Account | Password | Role | What it unlocks |
| --- | --- | --- | --- |
| `tic.raheel@gmail.com` | `Abc@123` | admin | Commercial signage and QA, the Phase 2 backend panel, campaign assignment. **Seeded on first boot** — no signup needed. |
| `raheel@retroflex.app` | *set via signup or password reset* | admin + source owner | Everything above, plus the Source Vault. |
| `demo@retroflex.app` | `demo1234` | demo | Driver-facing console and tablet only. **The commercial sections stay hidden.** |
| any new signup | — | driver | Sees the driver console; no signage tools. |

Admin accounts are seeded by `seedDefaultAdmins()` in `src/lib/demo.ts` from
`DEFAULT_ADMIN_ACCOUNTS` in `src/lib/access.ts`. An existing record is never
overwritten, so a changed password survives. Set `VITE_SEED_DEFAULT_ADMINS=off`
to ship a build with no administrator login at all — these are client-side
credentials that gate the admin UI, not a server boundary.

### One-click test setup

Sign in as an admin, open the **Booth** tab (the Settings tab is labelled
*Booth*), and press **"Seed demo campaign for this device"** in the
*Commercial signage and QA* section. That single button:

1. builds a static demo spot (SVG data URL — NSW Safety Mode only accepts images),
2. signs all six consent records and marks the campaign approved,
3. switches the **rear** profile for your pair code onto a commercial playlist
   with the parked confirmation set, and assigns the campaign to it,
4. mirrors it to the backend as approved.

`src/lib/demo.test.ts` asserts all of that, including that the campaign has
zero `campaignBlockReasons` under NSW safety mode on a rear screen.

### The two switches (they are separate on purpose)

| Switch | Covers | Default |
| --- | --- | --- |
| **NSW Safety Mode** | The road-safety rules of the glass: static media only, 10 s dwell floor (25 s at 80 km/h+), per-device parked confirmation, night brightness cap, no QR/referral overlay, black failure frame | on |
| **Legal & approval pack (NSW / Australia)** | Consent records, agreements, trademark authorization, the written permission register, authorization PDFs, campaign approval, referral terms, geographic rules | on |

Turn the pack off and the consent forms, the permission register and the
authorization buttons all disappear; campaigns you add display straight away and
are stamped `UNREGULATED`. They are marked on the glass with a **"TEST · NO LEGAL
PACK"** badge and in the console list, and — as agreed — they **keep displaying
when you switch the pack back on**, because they are test content, not approved
content. The badge has its own toggle ("Show "no legal pack" marker on the glass")
ready for client demos.

The pack switch takes a confirmation click and writes an activity-log entry every
time it changes. Compliance settings, not a legal opinion: the switch changes what
the app enforces, not what the road rules or your permits require.

### Watching it on the glass

Four separate switches decide whether the display is lit. A black screen is
usually one of these, not a broken campaign:

| Switch | Default | Where |
| --- | --- | --- |
| Console power | **off** | Live tab power switch |
| Device profile `powered` | on | Live tab device profile |
| Motion gate ("Display only while stopped") | on, 60 s stationary wait | Booth tab |
| Campaign assigned to *that* profile | — | Live tab → campaign chips |

The console now answers this for you: each campaign in the Commercial signage
list ends with a line saying either *"Ready for the rear glass…"* or
*"Not showing yet: …"* followed by the specific blockers (power switch off,
commercial playlist off, not assigned to this device, parked confirmation off,
motion gate waiting). When a campaign is on the glass and nobody can see it,
that line is the first thing to read.

Open the display at `?mode=tablet&display=PAIRCODE` (rear pair code from the
console) or `#/display/PAIRCODE` in a second tab. For a desk test, switch off
"Display only while stopped" — otherwise the glass stays black by design until
the app believes the car is parked.

To watch the approval workflow instead, create a campaign through the normal
form (it mirrors as *pending*) and approve it in the *Commercial backend* panel.
