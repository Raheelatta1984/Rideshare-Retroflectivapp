# The session service (BFF)

`server/bff` is a small same-origin server that sits between the browser and
Supabase. It exists for one reason: **a static single-page app cannot keep a
bearer token away from JavaScript.** Anything in `localStorage`, in memory, or
in a JS-set cookie is readable by any script that reaches the origin. Moving the
token behind an `HttpOnly` cookie requires a server that can set one, and that
is all this service is.

```
                 ┌──────────────────────────────┐
  browser  ────► │  static host + /bff (Node)    │ ────► Supabase
  (no token)     │  __Host-rf_session  HttpOnly  │       GoTrue / PostgREST / Storage
                 │  session store (pg/file)      │       forwarded with the USER's token
                 └──────────────────────────────┘
```

## What it fixes, and what it does not

| Property | Before (`src/lib/backend/supabase.ts`) | With the BFF |
| --- | --- | --- |
| Where the access token lives | Browser memory (previously `localStorage`) | Server-side session store; only a SHA-256 of an opaque cookie value is stored as the key |
| Can injected script read it? | Yes, while the tab is open | No — `HttpOnly` keeps it out of `document.cookie` |
| Survives a reload? | No (memory-only mode) | Yes, until idle (1 h) or absolute (12 h) expiry |
| Revocation | Delete browser state; the token stays valid until it expires | Delete the session row; the next request is unauthenticated |
| Credential at rest | n/a | AES-256-GCM with `BFF_SESSION_KEY` (required in production) |

**Not fixed by the BFF:** script running on the origin can still *use* the
session for as long as the page is open (it can call `/bff/api/...` with the
user's cookie). `HttpOnly` stops exfiltration, not action. That is why the CSP,
the "no HTML sinks" rule and the audit trail still matter.

## Request surface

| Method | Path | Session | CSRF | Purpose |
| --- | --- | --- | --- | --- |
| GET | `/bff/healthz` | – | – | Liveness; reports the session store kind |
| GET | `/bff/session` | optional | – | Current account + CSRF token |
| POST | `/bff/auth/signup` | – | origin only | Create an account and a session |
| POST | `/bff/auth/login` | – | origin only | Password grant |
| POST | `/bff/auth/refresh` | required | required | Rotate the cookie; refresh upstream token |
| POST | `/bff/auth/logout` | optional | required | Revoke the session, expire the cookie |
| GET | `/bff/campaigns` | optional | – | Own + approved (session) / approved only (anon) |
| GET | `/bff/campaigns/:id` | optional | – | Same rule for one row |
| PUT | `/bff/campaigns/:id` | required | required | Upsert; the server stamps `owner` |
| DELETE | `/bff/campaigns/:id` | required | required | Owner or reviewer |
| POST | `/bff/campaigns/:id/approval` | required | required | Reviewer only for approve/reject |
| POST | `/bff/events` | optional | when signed in | Proof-of-play; anonymous only for approved campaigns |
| GET | `/bff/events` | required | – | Own campaigns' events |
| GET/PUT | `/bff/devices` | required | PUT only | Bind a terminal (owner stamped server-side) |
| POST | `/bff/devices/:id/touch` | required | required | Heartbeat |
| DELETE | `/bff/devices/:id` | required | required | Unbind |
| POST | `/bff/assets` | required | required | Upload (base64 data URL, 8 MB cap) |
| POST | `/bff/assets/sign` | required | required | Short-lived signed URL |
| DELETE | `/bff/assets?path=` | required | required | Remove an object |
| POST | `/bff/manifest` | required | required | Sign a playlist from **approved rows the server reads itself** |
| POST | `/bff/manifest/verify` | – | – | Verify a manifest; the key never reaches the browser |
| GET | `/bff/public/pair/:code` | – | – | Pair-code check: `{found, position}` only |

## Security decisions worth knowing

**Cookies.** `__Host-rf_session=…; Path=/; Secure; HttpOnly; SameSite=Lax`.
The `__Host-` prefix is browser-enforced: no `Domain`, must be `Secure`, must be
`Path=/`, so a sibling subdomain cannot set or overwrite the session. `Lax`
rather than `Strict` because `Strict` drops the cookie on the first navigation
from an external link (an emailed link, a QR code), which would show a signed-in
user a signed-out page. `Lax` already blocks cross-site POST/PUT/DELETE, and
every state-changing request additionally needs the CSRF token.

**CSRF.** The token is `HMAC-SHA256(BFF_CSRF_SECRET, sha256(session token))`.
It is derived, not stored, so nothing has to be kept in sync and a token minted
for one session can never validate for another. State-changing requests must
carry it in `X-CSRF-Token`, must come from an allow-listed `Origin` (or
`Sec-Fetch-Site: same-origin`), and must send `Content-Type: application/json`
— a cross-site HTML form can send neither the header nor that content type.

**No service-role proxying.** User requests are forwarded with the *user's*
access token, so Postgres row-level security still decides. The BFF's own checks
(authentication, reviewer role, owner stamping, allow-listed tables) are a second
layer, not a replacement. The service-role key is used only by
`scripts/rotate-admin-credential.mjs`.

**Error text.** Upstream bodies can name tables, constraints and project refs.
They are logged server-side and replaced with a fixed vocabulary
(`Email or password is wrong.`, `The campaign service is unavailable.`).

**Reviewer role freshness.** The reviewer claim lives in the upstream access
token, so a role granted after sign-in is not visible to a token issued before
it. Rather than making the operator sign out and back in, the BFF reissues the
upstream token once (`reissueSession`) when an approve/reject request arrives on
a token without the claim, then re-checks. A transient refresh failure returns
the request as 403 without ending the session — the expiry path is the only one
that revokes.

**Rate limits.** Auth attempts are limited per client and per email (a
distributed password spray hits the email bucket), API calls per session, and
pair-code lookups hardest of all (20/minute): a six-character code is ~31 bits,
so exact-match lookups have to be expensive rather than merely unprofitable.

**Sessions at rest.** One row per session keyed by `sha256(token)`; the tokens
themselves are AES-256-GCM sealed. The production config refuses to start
without `BFF_SESSION_KEY`, without a durable store, or without
`BFF_ALLOWED_ORIGINS`.

## Running it

```bash
npm run build          # the SPA (dist/)
npm run bff:build      # the service (dist-server/bff.mjs)
npm run bff:smoke      # boots it against a stub Supabase and checks the surface

BFF_PORT=8080 BFF_HOST=0.0.0.0 BFF_STATIC_DIR=dist node dist-server/bff.mjs
```

Required environment:

```ini
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon key>
BFF_CSRF_SECRET=<32+ random characters>
BFF_ALLOWED_ORIGINS=https://app.example.com
BFF_SESSION_KEY=<32 bytes, base64>
BFF_SESSION_STORE=postgres          # or file for a single host
BFF_DATABASE_URL=postgres://…       # when the store is postgres
BFF_MANIFEST_SECRET=<random>        # optional: enables signed playlists
```

Then point the SPA at it (`VITE_BFF_BASE=/bff`, the default) and rebuild.

**Serving the SPA from the same origin is part of the design, not a
convenience.** A cross-origin BFF needs CORS plus `SameSite=None`, i.e. exactly
the weaker model this exists to avoid; `src/lib/backend/bff.ts` refuses a
cross-origin base for that reason.

### Deploying

* **Node host / container / Fly / Render** — run `dist-server/bff.mjs` with
  `BFF_STATIC_DIR=dist`. Postgres store for more than one instance.
* **Vercel** — the current static deployment cannot host this. Either move the
  SPA to a Node host that also serves `/bff`, or add a Vercel Function that
  mounts `createBffRouter` (the handler is fetch-native, so it drops in) and
  keep the SPA on the same domain.
* **GitHub Pages** — cannot host a server at all. A Pages deployment stays on
  the memory-only direct-Supabase adapter and keeps the residual token risk
  documented in `production-risks.md`.

## Verification

| Check | Where |
| --- | --- |
| Cookie attributes, CSRF, origin, expiry, rotation, revocation, rate limits, reviewer-role freshness | `server/bff/router.test.ts` (31 tests) |
| Token sealing, store durability, no plaintext at rest | `server/bff/sessions.test.ts` |
| Cookie serialisation and parsing | `server/bff/cookies.test.ts` |
| Real HTTP surface, static hosting, traversal, no token in any response | `scripts/bff-smoke.mjs` (33 checks) |
| Client adapter behaviour | `src/lib/backend/bff.test.ts` |
