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
