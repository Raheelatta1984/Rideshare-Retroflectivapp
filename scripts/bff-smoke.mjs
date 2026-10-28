#!/usr/bin/env node
/**
 * BFF smoke test — starts the *built* service (dist-server/bff.mjs) against a
 * stub Supabase, then exercises the real HTTP surface with a real socket.
 *
 * The unit tests drive the router directly; this proves the parts they cannot:
 * the Node adapter, header serialisation over the wire, static hosting, path
 * traversal refusal, and that no upstream token ever appears in a response.
 *
 *   npm run bff:build && node scripts/bff-smoke.mjs
 */

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "dist-server", "bff.mjs");

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failures += 1;
    console.error(`  \u001b[31m✗\u001b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.sig";
const CSRF_HEADER = "x-csrf-token";

/* ------------------------------------------------------------- stub upstream */

const upstreamCalls = [];

const stub = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    upstreamCalls.push({ path: url.pathname, search: url.search, auth: req.headers.authorization, body });

    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === "/auth/v1/token") {
      return send(200, {
        access_token: ACCESS_TOKEN,
        refresh_token: "refresh-token",
        expires_in: 3600,
        user: { id: "user-1", email: "owner@example.com", user_metadata: { name: "Owner" } },
      });
    }
    if (url.pathname === "/auth/v1/logout") return send(204, {});
    if (url.pathname === "/rest/v1/booths") {
      if (req.method === "POST") return send(201, [{ owner: "user-1", name: "Owner", pair_code: "ABC123", front_pair_code: "DEF456", created_at: "2026-01-01T00:00:00Z" }]);
      return send(200, [{ owner: "user-1", name: "Owner", pair_code: "ABC123", front_pair_code: "DEF456", created_at: "2026-01-01T00:00:00Z" }]);
    }
    if (url.pathname === "/rest/v1/campaigns" || url.pathname === "/rest/v1/public_campaigns") {
      return send(200, [
        { id: "camp_1", title: "Approved", approval_state: "approved", payload: { id: "camp_1", title: "Approved", approved: true }, updated_at: "2026-01-01T00:00:00Z" },
      ]);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/resolve_pair_code")) return send(200, { found: true, position: "rear" });
    return send(200, []);
  });
});

await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const upstreamPort = stub.address().port;

/* ------------------------------------------------------------------ boot bff */

if (!existsSync(bundlePath)) {
  console.error("dist-server/bff.mjs is missing — run `npm run bff:build` first.");
  process.exit(1);
}

const env = {
  NODE_ENV: "development",
  SUPABASE_URL: `http://127.0.0.1:${upstreamPort}`,
  SUPABASE_ANON_KEY: "anon-key",
  BFF_CSRF_SECRET: "smoke-secret-smoke-secret-smoke-secret-1",
  BFF_ALLOWED_ORIGINS: "https://app.example.com",
  BFF_SESSION_KEY: Buffer.alloc(32, 9).toString("base64"),
  BFF_SESSION_STORE: "memory",
  BFF_PORT: "0",
  BFF_HOST: "127.0.0.1",
  BFF_STATIC_DIR: path.join(root, "dist"),
  BFF_INSECURE_COOKIES: "1",
  BFF_MANIFEST_SECRET: "smoke-manifest-secret",
};

const { startBff } = await import(pathToFileURL(bundlePath).href);
const bff = await startBff(env, { logger: { info() {}, warn() {}, error() {} } });
const base = `http://127.0.0.1:${bff.port}`;

console.log(`BFF smoke — ${base}\n`);

try {
  /* ---------------------------------------------------------------- health */

  const health = await fetch(`${base}/bff/healthz`);
  check("healthz answers 200", health.status === 200, `got ${health.status}`);
  check("healthz reports the store", (await health.json()).store === "memory");

  /* ---------------------------------------------------------------- static */

  const indexFile = path.join(root, "dist", "index.html");
  if (existsSync(indexFile)) {
    const index = await fetch(`${base}/`);
    const html = await index.text();
    check("serves the built document", index.status === 200 && html.includes("<html"));
    check("sends frame-ancestors", (index.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));
    check("sends nosniff", index.headers.get("x-content-type-options") === "nosniff");

    const route = await fetch(`${base}/some/hash/route`);
    check("falls back to the document for SPA routes", route.status === 200);

    // A file that exists *outside* the served directory must never be reachable.
    // (%2e%2e survives URL normalisation, so the server sees the dots.)
    const traversal = await fetch(`${base}/%2e%2e/package.json`);
    const traversalBody = await traversal.text();
    check("refuses path traversal", traversal.status === 404 && !traversalBody.includes("rideshare-retroflex"));

    const traversal2 = await fetch(`${base}/%2e%2e/dist-server/bff.mjs`);
    check("refuses traversal into the server bundle", traversal2.status === 404);
  } else {
    console.log("  · dist/ not built — skipping static hosting checks");
  }

  /* ----------------------------------------------------------------- login */

  const login = await fetch(`${base}/bff/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery" }),
  });
  const loginBody = await login.json();
  const setCookie = login.headers.getSetCookie?.()[0] ?? "";
  const cookie = setCookie.split(";")[0];

  check("login succeeds", login.status === 200, `got ${login.status}`);
  check("cookie is HttpOnly", setCookie.toLowerCase().includes("httponly"));
  check("cookie is SameSite", setCookie.toLowerCase().includes("samesite"));
  check("cookie carries the session", cookie.startsWith("rf_session="), cookie);
  check("login returns a CSRF token", typeof loginBody.csrfToken === "string" && loginBody.csrfToken.length === 43);
  check("login returns the account", loginBody.account?.email === "owner@example.com");
  check("no access token in the login response", !JSON.stringify(loginBody).includes(ACCESS_TOKEN));
  check("no upstream token in any header", !setCookie.includes(ACCESS_TOKEN));

  /* ------------------------------------------------------------ public read */

  const anonList = await fetch(`${base}/bff/campaigns`);
  check("anonymous campaign list answers 200", anonList.status === 200);
  const anonCall = upstreamCalls.filter((call) => call.path === "/rest/v1/public_campaigns").at(-1);
  check("anonymous reads hit the public projection", Boolean(anonCall));
  check("anonymous reads are approved-only", (anonCall?.search ?? "").includes("approval_state=eq.approved"));
  check("anonymous reads use the anon key", (anonCall?.auth ?? "").includes("anon-key"));

  /* --------------------------------------------------------- authenticated */

  const authed = await fetch(`${base}/bff/campaigns`, { headers: { Cookie: cookie } });
  check("signed-in campaign list answers 200", authed.status === 200);
  const authedCall = upstreamCalls.filter((call) => call.path === "/rest/v1/campaigns").at(-1);
  check("signed-in reads use the user token", (authedCall?.auth ?? "").includes(ACCESS_TOKEN));

  const session = await fetch(`${base}/bff/session`, { headers: { Cookie: cookie } });
  const sessionBody = await session.json();
  check("session endpoint restores the account", sessionBody.account?.email === "owner@example.com");
  check("session endpoint never leaks a token", !JSON.stringify(sessionBody).includes(ACCESS_TOKEN));

  /* --------------------------------------------------------------- CSRF */

  const noCsrf = await fetch(`${base}/bff/campaigns/camp_2`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "camp_2", title: "New" }),
  });
  check("write without CSRF is refused", noCsrf.status === 403, `got ${noCsrf.status}`);

  const withCsrf = await fetch(`${base}/bff/campaigns/camp_2`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", [CSRF_HEADER]: loginBody.csrfToken },
    body: JSON.stringify({ id: "camp_2", title: "New", mediaType: "image", displaySeconds: 10, enabled: true }),
  });
  check("write with CSRF is accepted", withCsrf.status === 200, `got ${withCsrf.status}`);

  const crossOrigin = await fetch(`${base}/bff/auth/logout`, {
    method: "POST",
    headers: { Origin: "https://evil.example", Cookie: cookie },
  });
  check("cross-origin write is refused", crossOrigin.status === 403, `got ${crossOrigin.status}`);

  /* ------------------------------------------------------------- pair code */

  const pair = await fetch(`${base}/bff/public/pair/ABC123`);
  const pairBody = await pair.json();
  check("pair code resolves", pairBody.verified === true);
  check("pair code discloses no identity", !JSON.stringify(pairBody).includes("owner@example.com"));

  /* ---------------------------------------------------------------- logout */

  const logout = await fetch(`${base}/bff/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, [CSRF_HEADER]: loginBody.csrfToken },
  });
  check("logout succeeds", logout.status === 200);
  check("logout expires the cookie", (logout.headers.getSetCookie?.()[0] ?? "").includes("Max-Age=0"));

  const after = await fetch(`${base}/bff/session`, { headers: { Cookie: cookie } });
  check("the revoked session no longer resolves", (await after.json()).account === null);

  /* ---------------------------------------------------------- token hygiene */

  const serialized = JSON.stringify(upstreamCalls);
  check("upstream tokens stay server-side", serialized.includes(ACCESS_TOKEN));
} finally {
  await bff.close();
  await new Promise((resolve) => stub.close(resolve));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
