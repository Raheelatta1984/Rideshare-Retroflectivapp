# Production security status

These changes reduce risk but do not make the application secure against every
attack. Do not use the current shared Supabase setup for sensitive or
multi-tenant data without addressing the following:

* Rotate the previously exposed administrator password **out of band**, revoke
  existing sessions where applicable, and review login/audit activity. Removing
  a credential from source does not invalidate a leaked password. No live
  administrator account was accessed or rotated by this change.
* The Supabase BFF is not implemented. Tokens now live only in browser memory;
  reload requires login. Active malicious JavaScript can still use them. Build a
  same-origin BFF with an opaque, Secure, HttpOnly, SameSite cookie, CSRF/origin
  validation, a durable session store, rotation/revocation, and server-side
  authorization before restoring persistent sessions. A static GitHub Pages
  deployment alone cannot host that service.
* `0001_signage_phase2.sql` permits public reads of all campaign payloads and
  events, not just approved campaigns or aggregates. Any authenticated user
  can write or delete any campaign; approval audit and asset policies are also
  broad. `0003_terminal_signup.sql` exposes an enumerable booth directory with
  pair codes. These are not tenant isolation or authorization boundaries. The
  policies in a live Supabase project may differ; inspect them there. Restrict
  public exposure immediately at the deployment level if sensitive data is
  present. A safe replacement requires ownership/role models, separate public
  projections, authenticated device access and RLS integration tests; simply
  changing policies here could break displays and existing data access.
* Local accounts, reset codes, and session pointers are browser-local, not a
  server-enforced identity or authorization boundary. Never use them to protect
  privileged or confidential resources. Peer pair codes are not a substitute
  for authenticated communication.
* Public `VITE_*` values are included in the browser bundle. Do not put secrets
  in them. In particular, the current manifest implementation uses a symmetric
  HMAC key; a browser verification key is also capable of signing. Use
  asymmetric signatures and server-only private keys for trusted manifests.

Security controls must be verified against the actual deployment, database
policies, logs, and infrastructure; this repository alone cannot prove those
settings or revoke leaked credentials.
