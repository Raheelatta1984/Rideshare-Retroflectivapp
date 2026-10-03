# Retroflex — bug report & repair log

**Date:** 4 Oct 2026 · **Commit base:** `d7cdb8a` (main) · **Scope:** bug fixes + test coverage, no feature changes

Verified end to end with `npm run verify` (typecheck → 55 tests → build → artifact checks).

| | Before | After |
| --- | --- | --- |
| TypeScript errors (`tsc --noEmit`) | **168** | **0** |
| Tests | 3 | **55** (7 files) |
| Typecheck in the build | none | `npm run typecheck`, enforced in CI |
| Cross-device pairing | could not connect | dials by pair code over PeerJS cloud |

---

## 1. Corrupted template literals — 8 sites, 3 files *(the headline bug)*

Every `${...}` in eight places had been rewritten as `\( {...} \)`. This is the
signature of code that was round-tripped through a LaTeX/markdown renderer
(`$` → `\(...\)`). The files still parsed and the build still succeeded, so the
interpolations just silently stopped interpolating.

| File | Line | Was | Effect |
| --- | --- | --- | --- |
| `src/lib/id.ts` | 11 | `` `\( {prefix}_ \){timestamp}${randomPart}` `` | `uid("drv")` never applied its prefix — every driver, ride and log id was the literal text `\( {prefix}_ \){timestamp}<rand>` |
| `src/lib/devices.ts` | 28 | `` `\( {device.pairCode}: \){device.position}` `` | `deviceProfileId()` returned **one constant string for every device** — all tablets shared a single profile record and overwrote each other |
| `src/lib/sync.ts` | 69 | log tag | Console tag always printed `\( {pairCode}/ \){role}` |
| `src/lib/sync.ts` | 78, 397 | packet ids | Malformed `pkt_…` ids used for ack tracking |
| `src/lib/sync.ts` | 191, 470 | PeerJS ids | Every peer registered the **same literal id** — the pair code was never part of a peer identity, so two drivers' devices could not be told apart |
| `src/lib/sync.ts` | 251 | dial target | Target peer id was a wildcard string that PeerJS cannot resolve (see §2) |

**Fix:** rewrote the affected functions as real interpolations, and added
regression tests that assert no `{placeholder}` text can appear in generated ids
(`src/lib/id.test.ts`, `src/lib/devices.test.ts`).

## 2. The phone never dialled the tablet

`peer.on("open")` built `targetPeerId` … and then did nothing with it. There was
no `.connect()` call anywhere in the sync layer, so **PeerJS never opened a
connection** — the only working transport was `BroadcastChannel`, which is
same-browser only. Cross-device phone ↔ tablet pairing could not work as shipped.

**Fix:** deterministic, dialable peer identities derived from the pair code
(`retroflex-<CODE>-host` / `retroflex-<CODE>-display`), a real `peer.connect()`
with a 4 s retry loop, one shared wiring path for inbound and outbound
connections, quiet handling of `peer-unavailable` (tablet still booting) instead
of tearing the peer down, and an `unavailable-id` fallback that takes a suffixed
id if another tab already claimed the deterministic one.
Covered by 11 tests in `src/lib/sync.test.ts`.

## 3. Dead relay + a Create-React-App env variable

```ts
const RELAY_SERVER = process.env.REACT_APP_RELAY_SERVER || "https://relay.retroflex.app";
```

- `process.env.*` is the **CRA** convention. Vite only exposes `import.meta.env.*`,
  so the variable could never be configured and the fallback always won.
- `relay.retroflex.app` **does not resolve in DNS** (checked: no A record). Every
  open tab polled it every 3 seconds for nothing.
- The same host was used for TURN with a **hard-coded password**
  (`retroflex` / `beacon2024`) — committed credentials pointing at a dead host.

**Fix:** `VITE_RELAY_SERVER` (see `.env.example`), relay calls skipped entirely
when unset, signalling defaults to the public PeerJS cloud, TURN is env-driven
only, and the dead host/credentials are gone. `scripts/smoke.mjs` now fails the
build if `relay.retroflex.app` or `beacon2024` ever reappear in `dist/`.

## 4. Crash risks removed

| Risk | Where | Why it mattered |
| --- | --- | --- |
| `profileForDevice()` can return `null`, then `.position`/`.powered` read straight off it | `DriverConsole` sync effect | Threw mid-render → blank console whenever a device had no saved profile |
| `deliverAgreementPdf()` resolved to an **object** that callers put into `deliveryStatus` and rendered as a React child | `agreements.ts` → campaign legal panel | "Objects are not valid as a React child" blanked the panel after issuing a consent PDF |
| `getPlatform()` returned `undefined` for unknown ids, callers rendered `.name`/`.accent` | `platforms.ts` → history list | Crash listing a ride with an unrecognised platform |
| `settings.stopDelaySeconds` optional → `NaN` comparison | `DisplayScreen` arrival gate | The "stopped long enough → show the name" transition could never fire |
| Consent records assumed present | `DisplayScreen` compliance check | Crash on partial/legacy campaign data |

## 5. Type contract drift (168 → 0)

The components were written ahead of the types: they use fields the types never
declared. Declaring them (rather than deleting the usages) fixed ~140 errors:

- `DisplaySettings`: `sleepIndicator`, `frontDriverVisible`, `batteryAlertsEnabled`, `batteryAlertStep`, `batteryAlertCooldownMinutes`, `enterpriseQa` (+ new `EnterpriseQaResult`)
- `LegalConsent`: `email`, `confirmedAt`, `signedDocumentAt`, `deliveryStatus` (+ `DeliveryStatus`)
- `CommercialCampaignLegal`: `driverIsVehicleOwner`, `fullAuthorizationIssuedAt`, `fullAuthorizationDelivery`; the six consent slots are now **required** (as `blankCampaignLegal()` always wrote them)
- `ActivityLog`: `driverId`, `deviceId`, `deviceName`, `platforms`
- `DeviceProfile`: timing/brightness/apps fields now required (all defaulted by `createDeviceProfile`)
- `CommercialCampaign`: `createdAt`, `updatedAt`, `mediaType` accepts `"gif"`
- New `ConsentRole`; `AgreementRole` includes it
- Signature fixes: `codeProfileId(code, position)`, `deviceProfileId(id, position)`, `createDeviceProfile` (id/position now optional, defaults applied), `listTabletActivity(code, deviceId?)`, `createConsentPdf(document|draft)`, `deliverAgreementPdf(blob, recipients[], title)`
- `Platform` name collision resolved: components now treat platform values as **id strings**; `getPlatform()` is total

**Why it went unnoticed:** `npm run build` runs `vite build` only — esbuild strips
types without checking them. There is now a `typecheck` script, and CI runs it.

## 6. How to verify

```bash
npm ci
npm run verify        # typecheck + 55 tests + build + artifact checks
npm run dev -- --host 0.0.0.0     # then open #/lab
```

Manual pass (2 minutes): `#/lab` → flip the switch → `#/login` (`driver@retroflex.app` / `demo1234`) → Settings → change Auto brightness → `#/lab` again shows the new value. Details in `TESTING.md`.

## 7. Recommended next (not done — needs your call)

1. **`stopDelaySeconds` defaults to 30 s**, but the product copy says the name
   appears after **five seconds** of being stopped. Which is right?
2. **Stray files:** `public/Test.test`, `public/images/Test.test`, `scripts/Test.test`, `src/components/Test.test`, `src/utils/Test.test` — five empty placeholders in the shipped tree.
3. **`.devcontainer/` is still missing** even though the README credits it for Codespaces auto-start (Vite won't run there automatically).
4. **Cross-device pairing** now works through the public PeerJS cloud. If you want no third-party signalling, deploy your own PeerJS server and set `VITE_RELAY_SERVER`.
5. `src/components/DisplayScreen.tsx` `sleepIndicator` / `frontDriverVisible` are typed but appear unused by the display — confirm whether they should do something.
