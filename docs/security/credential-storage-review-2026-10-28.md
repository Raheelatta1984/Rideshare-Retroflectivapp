# Credential storage, cookie, XSS and header review — 2026-10-28

Scope: credential material that JavaScript can read (localStorage / sessionStorage / IndexedDB /
JS-set cookies), the XSS preconditions that make it exfiltratable, cookie transport, CSRF/CORS,
security headers and supply chain. One consolidated review for this repository.

Repository: `Raheelatta1984/Rideshare-Retroflectivapp` · default branch `main` ·
review branch `arena/210c8f85-rideshare-retroflectivapp`.

## 1. Stack and applicability verdict

| Detection | Result |
| --- | --- |
| Browser front-end | Vite 7 + React 19 SPA, hash router (`src/App.tsx`), built as a **single HTML file** (`vite-plugin-singlefile`, `vite.config.ts`) |
| Server / API | **None serves the app.** `server/` is a Node library of Postgres/cache helpers (`server/index.ts`) with no HTTP listener; `scripts/webhook-handler.ts` is a standalone GitHub webhook receiver that is not wired into the build |
| Hosting | Vercel static (`vercel.json`, rewrite to `/index.html`) and GitHub Pages (`.github/workflows/ci.yml` builds; `public.nojekyll`) |
| Auth | (a) local "booth" accounts in `localStorage` (`rf:drivers`), (b) Supabase GoTrue email/password for the terminal flow (`src/lib/backend/supabase.ts`) |
| Cookies | The app sets none (no `document.cookie`, no `Set-Cookie`, no `js-cookie`/`universal-cookie`) |
| Native app | none (no React Native / Expo / Capacitor) |

### Tier A — credential exposure: **APPLICABLE**

Browser-readable credentials exist (`localStorage`), and a shared administrator password ships in
the public bundle. Three sub-cases have different fixes:

- **A1 (fix now)** shared administrator password in source and in every seeded browser.
- **A2 (fix now)** local account passwords stored in cleartext and compared with `!==`.
- **A3 (DECISION REQUIRED)** Supabase access + refresh tokens persisted in `localStorage`. A
  static SPA cannot issue an `HttpOnly` cookie — this needs a backend/BFF or Supabase's SSR
  cookie client, i.e. a hosting change. Proposed migration in §6; no behaviour change is made
  to the default build.

Important framing, stated so nothing here over-claims: the *local* booth account is a UX
convenience, not an authentication boundary. The driver table, the session pointer and the reset
codes all live in the same origin's `localStorage`, and the reset flow renders the code in the
page. Any script that runs on this origin can read and rewrite all of it, so keeping a local
password out of JS reach is impossible by construction; what *is* fixable is that a password that
people reuse elsewhere must not sit in cleartext in a file, in a shared constant, or in a
record that is readable by any future XSS. The real data boundary is Supabase row-level security
(`supabase/migrations/*.sql`), not this client code. That is why A1/A2 are fixed here while A3 is
escalated: the tokens in A3 *are* a real boundary (they authorise Postgres) and they are exactly
the class this review targets.

### Tier B — defence in depth: **APPLICABLE**

The site is served as HTML with only `Referrer-Policy` (Vercel) and no headers at all on GitHub
Pages. There are **no XSS sinks** in application code (§4), which makes a strict CSP realistic.

### Tier C — supply chain: **APPLICABLE**

npm lockfile is committed and CI installs with `npm ci`, but there is no audit gate, no
Dependabot, Actions are pinned by tag, four dependencies use caret ranges, and `npm audit`
reports 7 advisories including 3 critical and 1 high.

## 2. What was searched (raw discovery)

Commands are reproduced with their real output in §8. Coverage:

1.2 web storage · 1.3 cookie attributes · 1.4 CORS/CSRF · 1.5 XSS sinks · 1.6 headers/CSP ·
1.7 third-party scripts + exposed tooling + tracked `.env` · 1.8 supply chain · 1.9 token design ·
1.10 runtime probe.

Notable "searched and found nothing" results, which are as load-bearing as the findings:

- `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
  `srcdoc`, `eval(`, `new Function(`, `setTimeout("…"`: **zero matches in application code**
  outside one test assertion (`src/app.boot.test.tsx:43` reads `document.body.innerHTML`).
- `document.cookie =`, `Cookies.set(`, `js-cookie`, `universal-cookie`: **zero matches**.
- `indexedDB`, `localforage`, `idb-keyval`, `redux-persist`: **zero matches**.
- Tracked `.env` files: only `.env.example` (documented, no values). `DEBUG`/swagger/graphiql/
  source-map toggles: none. No `/docs`, `/swagger`, `/graphql` route exists.
- CORS middleware: none; no `Access-Control-Allow-*` in the repo, and no cookie-auth, so CSRF
  from ambient credentials does not apply. Backend calls use an explicit `Authorization` header
  (`src/lib/backend/supabase.ts:316-330`), which cross-site requests cannot send without a CORS
  preflight this origin never grants — an incidental CSRF control that is preserved.

## 3. Findings

| # | Severity | Finding | Evidence | Action | Tier |
| --- | --- | --- | --- | --- | --- |
| 1 | **Critical** | Shared administrator password committed in source and re-seeded into every browser on boot; the literal is also in the deployed bundle. It is a real person's email credential in a public repository (and remains in git history). | `src/lib/access.ts:18` (`DEFAULT_ADMIN_ACCOUNTS` password literal), `src/lib/demo.ts:46-60` (`seedDefaultAdmins`), `src/store.tsx:113-127` (call at boot) | Remove the literal; seed the account **without** a password so it must be activated through the reset flow (same state the source-owner activation already uses, `src/store.tsx:190-212`). Rotate the password out of band; history rewrite is out of scope for this PR. | A |
| 2 | **High** | Local account passwords are stored in cleartext in `localStorage` and compared with string inequality, so the whole driver table is harvestable by any script that reaches the origin. | `src/types.ts:27` (`Driver.password`), `src/lib/storage.ts:51-56` (`saveDriver`), `src/store.tsx:179-183` (`found.password !== password`) | Hash with PBKDF2-SHA256 (WebCrypto, 210 000 iterations, per-record salt) in a versioned format; verify with a constant-time compare; migrate cleartext records on the next successful login; reject records with no usable credential. | A |
| 3 | **High** | Supabase `access_token` **and** `refresh_token` are persisted in `localStorage` (`rf:backend:supabase-session`), readable by any injected script; the refresh token is long-lived. | `src/lib/backend/supabase.ts:293-315` (`readStoredSession`/`writeStoredSession`), `:383-397` (`adoptSession`), `:465-472` (`signOut`) | **DECISION REQUIRED** — see §6. Adds an opt-in memory-only mode (`VITE_SUPABASE_SESSION_PERSISTENCE=memory`) so a deployment that can tolerate re-login on reload never writes the token at all; default unchanged. | A |
| 4 | **Medium** | Password-reset credentials are generated with `Math.random()` (predictable, 4 digits, `reset_` + base36), while the UI promises a six-digit code and "five incorrect attempts invalidate the code". No attempt counter exists. | `src/lib/storage.ts:146-215`, `src/components/PasswordReset.tsx:73,106` | Generate with `crypto.getRandomValues` (six digits, 128-bit token), count failed attempts, invalidate after five. | A |
| 5 | **Low** | The local session is a plain `{driverId}` pointer in `localStorage` under `rf:session`. | `src/lib/storage.ts:102-114` | Keep (it grants only what a same-origin script could already do by editing the driver table); documented, allowlisted in the storage guard. | A |
| 6 | **Medium** | Webhook signature verification fails **open**: with no `GITHUB_WEBHOOK_SECRET` set it returns `true` (accepts any payload), and `crypto.timingSafeEqual` throws on length mismatch instead of returning false. | `scripts/webhook-handler.ts:46-62` | Fail closed, length-check before comparing, compare digests of equal length. | A |
| 7 | **Medium** | No Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy` or HSTS. Only `Referrer-Policy` is set, and only on Vercel; GitHub Pages serves no headers. | `vercel.json:1-11` | Full header set on Vercel; hash-based CSP `<meta>` injected at build time so GitHub Pages is covered too; `frame-ancestors` (ignored in `<meta>`) enforced by header. | B |
| 8 | **Medium** | The production document is a single inline `<script>` (530 KB) built by `vite-plugin-singlefile`, so `script-src 'self'` alone would break the app and `'unsafe-inline'` would defeat the policy. Inline `style={{…}}` attributes (24 occurrences in 4 files) additionally require `style-src 'unsafe-inline'`. | `vite.config.ts:6`, `dist/index.html` (one inline module script) | `script-src` with a **sha256 hash of the emitted script**, computed by the build and re-verified in `npm run smoke`; `style-src` keeps `'unsafe-inline'` (attributes only) and is documented. | B |
| 9 | **Low** | Reset codes and reset tokens sit in `localStorage` next to the accounts, so a reset requested in this browser can be completed by any script on the origin within 30 minutes. | `src/lib/storage.ts:146-215` | Inherent to the offline flow; tokens are now 128-bit random and single-use, attempts capped. Documented as accepted for a browser-only recovery flow. | A |
| 10 | **Low** | Pairing QR codes are rendered by a third-party origin (`api.qrserver.com`), which receives the pair code — a capability that arms a display. | `src/lib/terminals.ts:76-85` | Allowlisted in `img-src` so the feature keeps working; recommended follow-up is local QR generation (no new dependency today). | B |
| 11 | **Low** | The demo booth ships a fixed, documented password and is seeded on boot. Its role is `demo` and it cannot reach admin tooling. | `src/lib/demo.ts:9-30`, `src/lib/access.ts:82-93` | Accepted deliberately (it is the public demo); allowlisted in the storage guard so it is an explicit decision, not an accident. | A |
| 12 | **High** (supply chain) | A critical DOMPurify advisory is reachable from a **runtime** dependency: `jspdf@4.2.1 → dompurify@3.4.16` (3 advisories, fixed in 3.4.17). | `package-lock.json`, `npm audit` | `overrides: dompurify 3.4.17`; audit gate added. | C |
| 13 | **High** (supply chain) | `vite@7.3.2` is in the vulnerable range (`<=7.3.6`) for dev-server advisories; `vitest@2.1.9`/`tinypool`/`@vitest/mocker`/`vite-node`/`esbuild` carry 1 critical + 3 moderate dev-only advisories. | `package.json:35`, `npm audit` | Bump `vite` to 7.3.7 (patch, inside every peer range). Vitest 2 → 5 is a breaking major; recorded in the audit allowlist with rationale and left as a follow-up. | C |
| 14 | **Medium** | GitHub Actions are pinned by floating tags (`actions/checkout@v4`, `actions/setup-node@v4`). | `.github/workflows/ci.yml:12,14` | Pin both to 40-character commit SHAs (`v4.4.0`) with a version comment. | C |
| 15 | **Low** | No dependency audit step and no Dependabot configuration. | `.github/workflows/ci.yml` | Add an audit gate (High/Critical, with a reviewed allowlist) and `.github/dependabot.yml` for npm + Actions. | C |
| 16 | **Info** | `isSafeAssetUrl` allows any `https?://` or `data:image|video/*` URL, and campaign assets can be remote. Rendering is `<img>`/`<video>` only (never `innerHTML`), so an SVG asset cannot execute script. | `src/lib/signage.ts:114-122`, `src/components/DisplayScreen.tsx:653-690` | No change; `img-src`/`media-src` allow `data:`, `blob:` and the Supabase origin only. A stricter allowlist is a product decision. | B |
| 17 | **Info** | Documentation advertises the shared administrator password. | `TESTING.md:113`, `PHASE-2.md:105-112`, `README.md:39-53` | Update to the activation flow. | — |

Severity totals: Critical 1 · High 4 · Medium 5 · Low 4 · Info 2 (plus 3 dev-toolchain advisories).

## 4. XSS position (the precondition for stealing anything)

- No sink in application code: all user-controlled strings render through JSX text/interpolate,
  which React escapes; no `dangerouslySetInnerHTML` anywhere.
- `public/tablet.html` (a separate static page) contained an inline script and an inline
  `<style>`. The script is moved to `public/tablet.js` so that page can run `script-src 'self'`.
- Escape-by-discipline does not exist here to harden; the structural control is React's
  auto-escaping plus CSP.

## 5. Plan (what this PR changes)

| File | Change |
| --- | --- |
| `src/lib/access.ts` | `DEFAULT_ADMIN_ACCOUNTS` keeps identity + role only; the password literal is deleted |
| `src/lib/demo.ts` | Seeds administrators with an empty credential (activation required) |
| `src/lib/password.ts` *(new)* | PBKDF2-SHA256 hash/verify, legacy-record detection, `needsRehash` |
| `src/lib/random.ts` *(new)* | `randomDigits`, `randomToken` over `crypto.getRandomValues` |
| `src/lib/storage.ts` | Hashes on reset-complete; crypto-strength 6-digit codes and 128-bit tokens; 5-attempt cap; async reset completion |
| `src/store.tsx` | `login`/`signup`/`resetPassword` become async, verify hashes, migrate cleartext records on success, refuse accounts with no credential |
| `src/components/Auth.tsx`, `src/components/PasswordReset.tsx` | Await the async calls, keep the same copy and layout |
| `src/lib/backend/supabase.ts` | Opt-in memory-only session mode; comment pointing at the BFF decision |
| `scripts/webhook-handler.ts` | Fail-closed signature verification |
| `src/lib/security/csp.ts` *(new)* | Pure CSP policy builder (hashes, verified origins only) |
| `scripts/csp.mjs` *(new)* | Hash extraction + `<meta>` injection helpers for the build and smoke checks |
| `vite.config.ts` | Inject the hash-based CSP `<meta>` into the built document |
| `vercel.json` | CSP safe subset + nosniff, referrer, frame-options, permissions, HSTS |
| `public/tablet.html`, `public/tablet.js` | External script, own `<meta>` CSP |
| `.github/workflows/ci.yml` | SHA-pinned Actions, audit gate, credential-in-storage guard |
| `.github/dependabot.yml`, `.github/security/audit-allowlist.json` *(new)* | Update automation + reviewed exceptions |
| `scripts/audit.mjs` *(new)* | Audit gate with allowlist |
| `package.json` | Exact pins, `vite` 7.3.7, `dompurify` override |
| tests | `src/lib/password.test.ts`, `src/lib/security/csp.test.ts`, `src/lib/security/headers.test.ts`, `src/lib/security/storage-guard.test.ts`, updated `demo`/`legacy-data` tests |

Deferred: BFF for Supabase tokens (§6), Vitest major upgrade, local QR generation, history
scrub of the removed password.

## 6. Tier A sub-case A3 — decision required (Supabase tokens)

The terminal flow authenticates against Supabase GoTrue directly from the browser
(`src/lib/backend/supabase.ts:400-450`) and keeps the returned `access_token` + `refresh_token`
in `localStorage` so a mounted tablet survives a reload. In a static SPA there is no way to set an
`HttpOnly` cookie; any storage the app can read, injected script can read too.

Options, in order of preference:

1. **BFF / SSR host (recommended).** Put a small server (Vercel function, Supabase Edge Function
   or the existing `server/` package) in front of GoTrue: browser posts credentials to
   `/api/session`, the server stores the Supabase session server-side and returns
   `__Host-session=<opaque id>; HttpOnly; Secure; SameSite=Lax; Path=/`, plus an Origin check on
   unsafe methods. The browser never sees a Supabase token. Requires a hosting change and a
   session store (Redis/Postgres), so it is not in this PR.
2. **`@supabase/ssr` cookie clients** if the app gains a Next/Remix-style server runtime. Not
   applicable to the current Vite static build.
3. **In-memory only** (implemented here as an opt-in): `VITE_SUPABASE_SESSION_PERSISTENCE=memory`
   stops persisting tokens at all. The token then dies with the tab — good for an operator
   console, unacceptable for a mounted tablet, hence opt-in.

Migration plan for option 1 (to be scheduled): add the session endpoint → dual-read (cookie
first, legacy storage fallback) → cutover behind a flag → delete `writeStoredSession` and purge
`rf:backend:supabase-session` once on boot → remove the fallback after the grace period. Rotation
of Supabase keys is not needed for this change; users would re-authenticate once.

## 7. Behaviour changes users will notice

- `tic.raheel@gmail.com` no longer has a shipped password. On a fresh browser the account exists
  but cannot be entered until a password is set through **Forgot password → email code → new
  password** (the same activation the source owner already uses). Existing browsers that already
  stored the old record keep working once, then the record is re-saved as a PBKDF2 hash.
- Nothing else changes: login, signup, reset and the terminal flow keep their copy and layout;
  the only difference is a brief "Working…" state while the hash is computed.

## 8. Status after this PR

| Finding | Status |
| --- | --- |
| 1 shared admin password | **Fixed** — literal deleted from source and bundle; seeded account starts locked |
| 2 clear-text local passwords | **Fixed** — PBKDF2-SHA256 records, constant-time verify, migrate-on-login, empty credential refused |
| 3 Supabase tokens in localStorage | **Deferred — decision required** (§6); opt-in memory-only mode added, default unchanged |
| 4 predictable reset codes/tokens | **Fixed** — CSPRNG codes (6 digits) and 128-bit tokens, single use, five-attempt cap |
| 5 `rf:session` pointer | **Accepted** — allowlisted in the guard, documented above |
| 6 webhook signature fail-open | **Fixed** — fails closed, length-safe compare, covered by tests |
| 7 missing headers | **Fixed** — Vercel header set + build-injected `<meta>` CSP for GitHub Pages |
| 8 inline single-file bundle vs CSP | **Fixed** — sha256-pinned `script-src`, verified by `npm run smoke` on every build |
| 9 reset credentials in storage | **Accepted** — inherent to an offline recovery flow; hardened as in #4 |
| 10 third-party QR generator | **Accepted** — allowlisted in `img-src`; local generation is a follow-up |
| 11 demo password | **Accepted** — public demo identity, role `demo`, cannot reach admin |
| 12 DOMPurify advisories | **Fixed** — `overrides: dompurify 3.4.17` |
| 13 dev-toolchain advisories | **Partly fixed** — `vite` 7.3.2 → 7.3.7, `vitest` 2 → 3.2.6 (both clean and green); the two remaining tinypool advisories are allowlisted with an expiry |
| 14 Actions pinned by tag | **Fixed** — both pinned to v4.4.0 commit SHAs |
| 15 no audit / no Dependabot | **Fixed** — `npm run audit` gate + `.github/dependabot.yml` |

## 9. Verification evidence

### 9.1 Baseline, before any change

```
npm run typecheck   -> tsc --noEmit, exit 0
npm test            -> 26 files, 334 tests passed
npm run build       -> dist/index.html 578.86 kB (gzip 169.17 kB)
npm run smoke       -> 9/9 PASS
npm audit           -> 7 vulnerabilities (3 moderate, 1 high, 3 critical)
```

No pre-existing failures: the baseline was green, so every failure in this PR would be mine.

### 9.2 After the change

```
npm run typecheck   -> tsc --noEmit, exit 0
npm test            -> 31 files, 370 tests passed   (+4 files, +36 tests)
npm run build       -> dist/index.html 582.19 kB (gzip 170.21 kB)
npm run smoke       -> 16/16 PASS
npm run audit       -> passed (2 accepted High+ advisories, both dev-only, expire 2027-01-31)
npm audit           -> 4 vulnerabilities (1 low, 1 moderate, 2 critical — all dev-toolchain, allowlisted)
```

New tests: `src/lib/password.test.ts` (7), `src/lib/security/csp.test.ts` (10),
`src/lib/security/headers.test.ts` (6), `src/lib/security/storage-guard.test.ts` (4),
`scripts/webhook-handler.test.ts` (3), plus reset-credential and hashed-write cases in
`src/lib/storage.test.ts` and `src/lib/backend/accounts.test.ts`.

### 9.3 The credential scans, re-run after the change

```
$ rg -n -i '(localStorage|sessionStorage)\.(setItem|getItem|removeItem)\s*\(\s*[^,)]{0,40}(token|jwt|auth|session|secret|api[_-]?key|credential|refresh|id_token|access)' src --glob '!*.test.*'
src/lib/storage.ts:113,116,121        rf:session                (finding 5 — allowlisted)
src/lib/backend/supabase.ts:278,327,343,344  SESSION_KEY         (finding 3 — deferred, §6)

$ rg -n 'password\s*:\s*"[^"]+"' src --glob '!*.test.*'
src/lib/demo.ts:12                    public demo identity      (finding 11 — accepted)

$ rg -n 'document\.cookie\s*=|dangerouslySetInnerHTML|\.innerHTML\s*=|new Function\(|[^a-zA-Z_.]eval\(' src --glob '!*.test.*'
(no matches)
```

`npm run security:storage` (also a CI step) fails the build for either pattern, keeps the
allowlist honest (a stale entry fails too), and forbids JS-set cookies and raw-HTML sinks outright.

### 9.4 Header / cookie / CSRF probe

Served the production build with `vite preview` (the sandbox has no browser binary, so this is
curl-level evidence):

```
$ curl -D - http://localhost:4173/
HTTP/1.1 200 OK
Content-Type: text/html
Cache-Control: no-cache
(no Content-Security-Policy / X-Content-Type-Options / … headers)
```

That is expected and is why headers live in `vercel.json`: `vite preview` is not Vercel. The
deployment-time values are asserted by `src/lib/security/headers.test.ts`:

```
Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(self), payment=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

- **Cookie attributes**: not applicable — this build sets no cookies (`Set-Cookie` is never
  emitted; there is no `document.cookie` write and no cookie helper in the tree). The
  `__Host-` recipe in §6 is the proposed shape *when* a cookie appears, i.e. with the BFF.
- **CSRF probe**: not applicable for the same reason — no ambient credential exists to ride.
  Backend calls carry an explicit `Authorization` header, which a cross-site form cannot set and
  a cross-site `fetch` cannot send without a preflight this origin never grants (no CORS
  middleware anywhere in the repo). That control is preserved: nothing in this PR removes the
  header or adds CORS.
- **Permissions-Policy** keeps `geolocation=(self)` because the motion-safety gate reads position
  (`src/lib/motion.ts:21-95`); denying it would silently break the parked check.
- **Exposed tooling**: `/docs`, `/swagger`, `/graphql`, `/redoc` return the SPA shell (no such
  routes exist); `server/` has no HTTP listener. No `DEBUG`, no source maps, no `.env` tracked.

### 9.5 CSP, verified against the artifact

The built document carries (injected by `vite.config.ts` → `scripts/csp.mjs`):

```
default-src 'self'; script-src 'self' sha256-oaIWUZNgyk8FNMXa8JgYIRAl7cZSORpF7BDD4gdj6NM=;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src 'self' data: blob: https://images.pexels.com https://api.qrserver.com;
media-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com;
connect-src 'self' wss://0.peerjs.com https://0.peerjs.com; manifest-src 'self';
object-src 'none'; base-uri 'none'; form-action 'self'; upgrade-insecure-requests;
```

`npm run smoke` recomputes the sha256 of the inlined script from `dist/index.html` and compares it
with the policy on every build — a drifting hash (which would kill the app in a browser) fails the
build instead of production. The hash itself changes per build; the check is the invariant.
`script-src` contains no `'unsafe-inline'`, no `'unsafe-eval'`, and no wildcard. `style-src` is the
only directive with `'unsafe-inline'`, required by the injected `<style>` block and React's inline
style attributes (24 occurrences in 4 files).

`public/tablet.html` moved its script to `public/tablet.js` and ships
`script-src 'self'` in its own `<meta>` policy; it is served by both hosts.

### 9.6 Supply chain

```
dompurify  3.4.16 -> 3.4.17         (npm overrides; runtime, shipped in the bundle)
vite       7.3.2  -> 7.3.7          (direct devDependency; inside every peer range)
vitest     2.1.9  -> 3.2.6          (green: 370/370; clears the vitest + esbuild advisories)
left:      tinypool 1.1.1 (2 critical, dev-only) — allowlisted with an expiry, see below
```

`npm run audit` fails on any High/Critical advisory that is not in
`.github/security/audit-allowlist.json`, and fails when an allowlist entry has expired. Both
remaining entries are the same dev-only worker pool; the fix requires vitest 4/5, whose install
fails in this workspace (`npm error Cannot read properties of null (reading 'edgesOut')` — an npm
resolver bug against this lockfile), so upgrading is a deliberate follow-up rather than a rushed
lockfile regeneration. CI now also runs Dependabot weekly.

### 9.7 What could not be verified here

- **No browser harness.** There is no Playwright/Cypress suite and no browser binary in this
  environment, so CSP enforcement is verified statically (hash matches the emitted script, no
  eval-like constructs in the bundle) rather than by watching a console for violations. The first
  deployment should be opened with DevTools and checked for `Refused to …` lines.
- **GitHub Pages** cannot send headers: it gets the `<meta>` CSP but not `frame-ancestors`,
  `nosniff` or HSTS. If GitHub Pages remains a production host, put a proxy in front of it or move
  the deployment.
- The webhook's deploy call is stubbed by signing a non-main ref, so the Arena deploy API is never
  invoked from tests.

## 10. Rollback

Revert the squash commit. Users who set a password keep working (a hash verifies the same
password); a browser that still holds a clear-text record from the previous build is upgraded
again on the next login. No data migration or secret rotation is involved in the code rollback —
but the removed administrator password must be treated as compromised regardless (it is in the
public git history) and rotated on the real account.
