# Terminal sign-up — scan, log in, assign, glass

One QR code for every terminal. A driver (or whoever is holding the tablet) scans
it and gets a bare sign-up shell — **no landing page, no marketing, no lab, no
console**. Two ways in, one Assign step, then the tablet becomes the display and
stays the display. Everything after that is driven from the driver's phone.

```text
https://YOUR-APP-URL/?mode=terminal            generic sign-up QR (no code in it)
https://YOUR-APP-URL/?mode=terminal&display=7K2M9Q   a driver's coded QR
https://YOUR-APP-URL/#/terminal                same shell, hash route
```

The generic QR is in the driver app under **Glass → Terminal sign-up QR**: copy
the link, preview the flow, or print the image. It carries no pair code, so it
never leaks a booth and never expires.

## The flow

| Step | Screen | What happens |
| --- | --- | --- |
| 1 | Gate | **I have a pair code** · **Create a terminal account** · *Log in with email instead* |
| 2a | Code | Six characters. A complete code submits itself. |
| 2b | Sign-up | Name, email, password (8+), phone and city optional. Mints the booth's rear and front codes. |
| 2c | Email | For a returning account whose code rotated. |
| 3 | Assign | Pair code · **Rear glass** or **Front display** · terminal name → *Assign and start the display* |
| 4 | Glass | `DisplayScreen`, fullscreen. The setup screens are gone. |

If the URL already carried a code, step 1 and 2 are skipped and the terminal
lands on Assign directly.

## What Assign writes

- `rf:tablet-consent:<position>:<CODE>` — assigning **is** the authorization, so
  the old "I authorize display control" gate never asks again on reload.
- a `TerminalBinding` (`deviceId`, `deviceName`, `pairCode`, `position`,
  `accountId`, `origin`, `assignedAt`) in the backend registry, plus a
  device-local pointer `rf:terminal-binding` so a reload goes straight to the
  glass without a provider round-trip.
- a `DeviceProfile` in the owning booth's settings, labelled with the name typed
  on the tablet. That is what the phone console lists, and what the `hello`
  packet announces, so the two names match.
- a tablet activity entry (`Terminal assigned`), visible on the terminal's own
  log screen and in the booth's activity ledger.

Re-assigning the same tablet from rear to front **replaces** the binding — one
physical terminal holds one position, no ghost devices.

## Security posture

- **A pair code is not a password.** Code login binds a display; it deliberately
  does *not* create a console session, so a passenger who finds a QR cannot open
  the driver booth on the tablet. Sign-up and email login are real credential
  checks and do sign the browser in.
- **Only the booth that owns the code is written to.** A mistyped code cannot
  attach a terminal to somebody else's settings; it produces an unverified
  binding, and the screen says so instead of pretending the lookup succeeded.
- The terminal shell renders no links at all. There is no navigation out to the
  website from a scanned terminal.

## Who controls what

| | Terminal (tablet) | Driver phone |
| --- | --- | --- |
| Sign up / log in / assign | ✅ | — |
| Power switch, brightness, apps, campaigns, schedules | ❌ | ✅ |
| Release a terminal | ❌ (clear site data) | ✅ Glass → Assigned terminals → Release |

A terminal that just **signed up** has no phone paired yet, so its beacon is lit
by itself — otherwise the driver signs up and stares at a black screen. A
terminal that **joined an existing booth** leaves the driver switch exactly where
its owner set it: OFF stays blank OLED-black.

Settings reach the glass as `bootstrapSettings`, not `settings`. That distinction
matters: `settings` wins over everything, so passing it would freeze the terminal
on a snapshot and ignore the phone forever. Bootstrap settings apply only until
the first remote packet (or a cached driver command) arrives — then the phone is
the authority, as designed.

## Backends

The flow is provider-agnostic. Everything goes through `Backend.accounts` and
`Backend.terminals` (`src/lib/backend/types.ts`), so no component knows which
adapter is running.

**Local (default, zero config).** Accounts are the booth records already in
`rf:drivers`; bindings live in `rf:backend:terminals`. Fully functional on one
device, and the code path the demo, the tests and any deployment without a
server use. A code issued on another phone cannot be *confirmed* here — the
terminal still pairs over the pair-code channel (PeerJS/BroadcastChannel), and
the Assign screen says the code is unconfirmed rather than lying about it.

**Supabase (shared).** Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then
apply `supabase/migrations/0003_terminal_signup.sql`:

- `booths` — one row per account, holding `pair_code` / `front_pair_code`. This
  is what makes a code resolvable from a different device.
- `booth_directory` — anon-readable view with **no email and no phone**, used to
  confirm a scanned code without exposing who owns it.
- `devices` (from 0001) extended with `device_key`, `account_email`,
  `assigned_at`, `origin`, `status`, and a unique `(device_key, position)` index.

Sign-up and login go to Supabase Auth over REST (`/auth/v1/signup`,
`/auth/v1/token?grant_type=password`). The adapter degrades instead of breaking:

| Situation | Behaviour |
| --- | --- |
| Migration 0003 not applied | `resolvePairCode` falls back to the device; the insert retries without the new columns |
| Email confirmation enabled | Sign-up reports "open the confirmation email" instead of silently failing |
| Email already registered | GoTrue's empty `identities` array becomes "An account already exists" |
| No session (anonymous code login) | The binding stays on the terminal — there is deliberately no anon write policy on `devices` |
| Offline / RLS denial | Falls back to the local adapter, so the glass still comes up |

## Files

```text
src/lib/terminals.ts                  routing, keys, identity, validation (pure)
src/lib/backend/types.ts              AccountRepository + TerminalRegistry contracts
src/lib/backend/local.ts              on-device accounts and terminal registry
src/lib/backend/supabase.ts           Supabase Auth + booths/devices over REST
src/components/TerminalSetup.tsx      the shell: gate → code/sign-up/email → assign
src/store.tsx                         signUpTerminal · signInTerminal · resolveTerminalCode · assignTerminal · releaseTerminal
src/App.tsx                           ?mode=terminal routing, TerminalFlow, bound-booth display
src/components/DriverConsole.tsx      Glass tab: sign-up QR + assigned terminals
supabase/migrations/0003_terminal_signup.sql

src/lib/terminals.test.ts             24 tests — routing, keys, repair, validation
src/lib/backend/accounts.test.ts      19 tests — both adapters, incl. degradation paths
src/components/TerminalSetup.test.tsx 14 tests — the flow a driver actually walks
src/app.terminal.test.tsx              8 tests — routing guards and the reload path
```

## Test it in two minutes

```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

1. Open `/?mode=terminal` → **I have a pair code** → `7K2M9Q` (demo booth) → Assign.
2. Open `/?mode=terminal` → **Create a terminal account** → assign → the beacon lights.
3. Log into the demo booth on the phone view (`#/login`, `driver@retroflex.app` /
   `demo1234`) → **Glass** → the terminal sign-up QR and the assigned terminal list.
