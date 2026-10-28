# Production security status

Last updated 2026-10-28. This file is the honest ledger: what is fixed in the
repository, what is fixed only once you deploy it, and what no repository can
fix. Read the **Open** table first.

## Open

| # | Risk | Why code cannot close it | Action |
| --- | --- | --- | --- |
| 1 | **Leaked administrator password** | The literal shipped in `src/lib/access.ts` and is in the public git history. Removing it from the current tree does not invalidate it. | Follow `docs/security/administrator-credential-rotation.md`: rotate at the identity provider, revoke sessions, review sign-in history, rotate the Supabase user and API keys. `scripts/rotate-admin-credential.mjs` automates the Supabase part. **Until this is done, treat the credential as live.** |
| 2 | **The live deployment may not match this repository** | Policies, env vars, bucket visibility and CDN headers are deployment state. This repo cannot read them, and the sandbox has no route to a Supabase project. | `npm run db:harden -- --dry-run` (then `--apply --grant-admin <owner> --revoke-sessions`), then sign that account in again — `docs/security/rls-model.md` has the exact order. Open the deployed app with DevTools and confirm one CSP header, one `__Host-rf_session` cookie and zero `Refused to …` lines. |
| 3 | **Not every host can run the BFF** | GitHub Pages is static: it cannot set an `HttpOnly` cookie, so a Pages deployment stays on the memory-only direct-Supabase adapter. | Deploy `server/bff` on a Node host (`docs/security/bff.md`) if the deployment holds anything worth stealing; otherwise accept risk #4 knowingly. |
| 4 | **Consent metadata of approved campaigns is readable by any signed-in account** | `public_campaigns` redacts it for anonymous readers; `campaigns_own_read` does not for authenticated ones, and signup is a terminal flow, so the redaction is only a speed bump. Pinned by test so it cannot widen silently. | If signup is open to the public, treat it as personal-data exposure. Closing it needs the display playlist read moved to the projection first (a signed-in display must not go blank), then the policy narrowed — steps in `docs/security/rls-model.md`, "Residual: consent metadata of approved campaigns". |

## Fixed in code

| Risk | Fix | Evidence |
| --- | --- | --- |
| Shared admin password in source and bundle | Literal removed; the seeded account starts locked and must be activated through the reset flow | `src/lib/access.ts`, `src/lib/demo.ts`, `src/lib/security/*` |
| Local passwords in cleartext | PBKDF2-SHA256 (210k iterations, per-record salt), constant-time verify, migrate-on-login | `src/lib/password.ts` + tests |
| Predictable reset codes | CSPRNG six-digit codes and 128-bit tokens, single use, five-attempt cap | `src/lib/storage.ts` + tests |
| Token in browser storage | Session tokens live server-side (BFF); cookie is `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`; the direct adapter is memory-only and deletes the legacy key | `server/bff/*`, `src/lib/backend/bff.ts`, `src/lib/backend/supabase.ts` |
| No CSRF protection | Derived per-session CSRF token + exact-origin check + JSON content type on every state-changing route | `server/bff/router.ts`, `server/bff/router.test.ts` |
| Webhook signature fail-open | Fails closed, length-safe compare | `scripts/webhook-handler.ts` |
| No security headers | Vercel header set, build-injected hash-pinned `<meta>` CSP, and the BFF server sends the header-only directives too | `vercel.json`, `scripts/csp.mjs`, `server/bff/node.ts` |
| `using (true)` policies on campaign data | 0005/0006 replace them with ownership + reviewer roles; anonymous access is limited to `public_campaigns` | `supabase/migrations/0005…`, `0006…`, `supabase/tests/rls.test.ts` (37 assertions on real Postgres) |
| 0005 and 0006 applied separately, leaving no anonymous read path | `npm run db:harden` applies both in one transaction, verifies 13 post-conditions inside it, and rolls back if any fails | `scripts/db-hardening.mjs`, `supabase/tests/hardening.test.ts` (30 assertions, including the rollback and adopting pre-0005 rows) |
| Pre-0005 rows stay ownerless, so nobody can edit their own campaigns | `npm run db:assign-owners` lists them and adopts them, refusing to guess when several accounts exist and never overwriting an existing owner | `scripts/assign-legacy-owners.mjs`, `supabase/tests/hardening.test.ts` |
| No way to grant the reviewer role safely | `npm run auth:grant-admin` (SQL or Admin API), idempotent, merges `app_metadata`, can end the account's sessions | `scripts/grant-admin.mjs`, `scripts/db-hardening.test.ts` |
| Enumerable booth directory | View dropped; exact-match `resolve_pair_code()` returns `{found, position}` only; BFF rate limits lookups | `0006`, `server/bff/router.ts` |
| Consent PII in campaign payloads | Public projection redacts the six consent records to booleans + "on file" for anonymous readers (signed-in readers still see the raw values — open risk #4) | `0006` |
| Anonymous reads of event telemetry | Revoked; the rollup view is `security_invoker` | `0005` |
| Any signed-in user could rewrite any campaign's assets | Storage policies scoped to the owning campaign's folder | `0005` |
| Any signed-in user could rebalance the id plane | Reviewer-only; `next_id()` no longer executable by browser roles | `0005` |
| Manifest signing key in the browser | With the BFF, signing happens server-side (`POST /bff/manifest`) and the browser holds no key | `server/bff/router.ts`, `src/lib/backend/bff.ts` |
| Dependency advisories | `npm run audit` gate + Dependabot; allowlist is empty | `.github/security/audit-allowlist.json`, CI |

## Accepted residual risks

* **XSS still acts as the user.** `HttpOnly` stops token theft, not token use. A
  script on the origin can call the same endpoints the UI calls for as long as
  the page is open. The controls are the hash-pinned CSP, the storage guard that
  forbids HTML sinks, and the audit trail — not the cookie.
* **The BFF is one process per deployment.** Its rate limiter is per-instance
  unless a shared memcached is configured (`BFF_*_LIMIT`); multi-instance
  deployments should also front it with the platform's edge limiter.
* **The campaigns storage bucket is public.** The creative is displayed in
  traffic; that exposure is the product. Writes are owner-scoped. To make reads
  private, flip `storage.buckets.public` to `false` — the read policy in 0005 is
  already correct for that — and switch `assetUrl` to `assets.signedUrl()`.
* **Local booth accounts are a UX convenience, not an authorization boundary.**
  They live in the same origin's `localStorage` as the session pointer and reset
  codes. Never use them to protect privileged or confidential resources; the
  boundary is Postgres RLS plus the BFF.
* **Pair codes are 31 bits.** Safe only because lookup is exact-match, rate
  limited and returns nothing identifying. Do not reuse them as secrets.
* **`VITE_*` values are public.** Do not put secrets in them. With the BFF the
  only remaining one is the Supabase anon key and the Supabase URL, which are
  public by design.
* **The HMAC manifest is symmetric when the BFF is not used.** A browser that can
  verify can also sign, so a static-only deployment cannot have trusted
  manifests. Use the BFF, or move to Ed25519 with a server-held private key
  (tracked, not done).

## What was verified here, and what was not

Verified in this repository, in CI:

* Static-only leaks: no tracked `.env`, no `dangerouslySetInnerHTML`/`innerHTML`,
  no `document.cookie =` (enforced by `npm run security:storage`).
* BFF behaviour: 47 unit tests plus 33 real-HTTP smoke checks on the built
  bundle (cookie attributes, CSRF, origin, rotation, revocation, traversal,
  "no token in any response").
* Database policies: `npm test` applies `0001`–`0007` to a real PostgreSQL
  (PGlite/WASM) and exercises them as `anon`, two drivers and a reviewer
  (37 assertions), plus 30 deploy-step assertions (0005+0006 atomicity, rollback,
  the reviewer grant, adopting pre-0005 rows) and a static migration audit.
* Build output: hash-pinned CSP, header set, smoke checks.

Not verified here, because it needs the real deployment:

* The live Supabase project's actual policies, bucket visibility and grants.
* The hosting layer's headers (Pages sends none; Vercel and the BFF do).
* Any browser-level behaviour: there is no browser harness, so CSP enforcement
  is verified statically (hash matches the emitted script, no eval-like
  constructs) rather than by watching a console.
* Whether the leaked password still works anywhere. Only rotation settles that.

Security controls must be verified against the actual deployment, database
policies, logs and infrastructure. This repository alone cannot prove those
settings, and it cannot revoke a leaked credential.
