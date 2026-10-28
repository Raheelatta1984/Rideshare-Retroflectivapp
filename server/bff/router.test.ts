// @vitest-environment node
/**
 * Router tests.
 *
 * These call the handler directly, exactly as `node.ts` does, so the
 * assertions are about the real request/response path rather than a
 * reimplementation of it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readBffConfig } from "./config";
import { createBffRouter } from "./router";
import { createMemorySessionStore } from "./sessions";
import { createRateLimiter } from "../limits/rateLimit";
import type { Upstream, UpstreamSession } from "./upstream";
import { UpstreamError } from "./upstream";

const ORIGIN = "https://app.example.com";
const BASE = `${ORIGIN}/bff`;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(role: string | undefined, exp = Math.floor(Date.now() / 1000) + 3600): string {
  const payload = { sub: "user-1", email: "owner@example.com", exp, app_metadata: role ? { role } : {} };
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.signature`;
}

interface FakeCall {
  path: string;
  method: string;
  token?: string;
  body?: unknown;
}

/**
 * A small PostgREST/GoTrue stand-in. It implements only the queries the router
 * issues, and it enforces the two RLS rules the BFF relies on: anonymous
 * readers see approved campaigns only, and devices belong to their owner.
 */
function createFakeUpstream() {
  const calls: FakeCall[] = [];
  const users = new Map<string, { password: string; data: Record<string, string>; id: string }>([
    ["owner@example.com", { password: "correct horse battery", data: { name: "Owner" }, id: "user-1" }],
    ["admin@example.com", { password: "correct horse battery", data: { name: "Admin" }, id: "user-2" }],
  ]);
  const booths: Array<Record<string, unknown>> = [];
  const devices: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const campaigns = new Map<string, { row: Record<string, unknown>; owner: string }>([
    ["camp_approved", { owner: "user-1", row: { id: "camp_approved", title: "Approved", approval_state: "approved", payload: { id: "camp_approved", title: "Approved", approved: true }, updated_at: new Date().toISOString() } }],
    ["camp_draft", { owner: "user-1", row: { id: "camp_draft", title: "Draft", approval_state: "draft", payload: { id: "camp_draft", title: "Draft", approved: false }, updated_at: new Date().toISOString() } }],
  ]);

  let refreshCount = 0;

  const upstream: Upstream = {
    async signUp({ email, password, data }) {
      if (users.has(email)) return { session: null, alreadyRegistered: true, needsConfirmation: false };
      const id = `user-${users.size + 1}`;
      users.set(email, { password, data, id });
      const session = grant(email, id);
      return { session, alreadyRegistered: false, needsConfirmation: false };
    },
    async signIn(email, password) {
      const user = users.get(email);
      if (!user || user.password !== password) throw new UpstreamError(400, "Email or password is wrong.");
      return grant(email, user.id);
    },
    async refresh(refreshToken) {
      refreshCount += 1;
      const email = refreshToken.replace(/^refresh:/, "");
      const user = users.get(email);
      if (!user) throw new UpstreamError(401, "Email or password is wrong.");
      return grant(email, user.id);
    },
    async logout() {
      calls.push({ path: "auth/logout", method: "POST" });
    },
    async rest(path, init, bearer) {
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ path, method, token: bearer, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const [route, query = ""] = path.split("?");
      const params = new URLSearchParams(query);

      if (route === "rpc/resolve_pair_code") {
        const code = (JSON.parse(String(init.body)) as { p_code: string }).p_code;
        const booth = booths.find((row) => row.pair_code === code);
        return json({ found: Boolean(booth), position: booth && booth.front_pair_code === code ? "front" : "rear" });
      }

      if (route === "booths") {
        if (method === "GET") {
          const owner = params.get("owner")?.replace("eq.", "");
          return json(booths.filter((row) => row.owner === owner));
        }
        if (method === "POST") {
          const row = (JSON.parse(String(init.body)) as Array<Record<string, unknown>>)[0];
          booths.push(row);
          return json([row]);
        }
      }

      if (route === "campaigns" || route === "public_campaigns") {
        if (method === "GET") {
          let rows = [...campaigns.values()];
          // The projection from 0006 is approved-only by construction.
          if (route === "public_campaigns") {
            rows = rows.filter((entry) => entry.row.approval_state === "approved");
          }
          const anonymous = !bearer || bearer === "anon-key";
          if (anonymous || params.get("approval_state") === "eq.approved") {
            rows = rows.filter((entry) => entry.row.approval_state === "approved");
          }
          if (anonymous) rows = rows.filter((entry) => entry.row.approval_state === "approved");
          const id = params.get("id");
          if (id?.startsWith("eq.")) rows = rows.filter((entry) => entry.row.id === id.slice(3));
          if (id?.startsWith("in.(")) {
            const ids = id.slice(4, -1).split(",");
            rows = rows.filter((entry) => ids.includes(String(entry.row.id)));
          }
          return json(rows.map((entry) => entry.row));
        }
        if (method === "POST") {
          const row = (JSON.parse(String(init.body)) as Array<Record<string, unknown>>)[0];
          const existing = campaigns.get(String(row.id));
          const owner = String(row.owner ?? existing?.owner ?? "");
          // RLS: a signed-in user may only write rows they own.
          const caller = userForToken(bearer);
          if (existing && caller !== existing.owner) return new Response("forbidden", { status: 403 });
          campaigns.set(String(row.id), { owner: owner || caller || "", row });
          return json([campaigns.get(String(row.id))!.row]);
        }
        if (method === "DELETE") {
          const id = params.get("id")?.replace("eq.", "") ?? "";
          campaigns.delete(id);
          return new Response(null, { status: 204 });
        }
      }

      if (route === "approval_audit" && method === "POST") return new Response(null, { status: 201 });

      if (route === "campaign_events") {
        if (method === "POST") {
          const batch = JSON.parse(String(init.body)) as Array<Record<string, unknown>>;
          events.push(...batch);
          return new Response(null, { status: 201 });
        }
        if (method === "GET") return json(events);
      }

      if (route === "devices") {
        if (method === "GET") return json(devices);
        if (method === "POST") {
          const row = (JSON.parse(String(init.body)) as Array<Record<string, unknown>>)[0];
          const index = devices.findIndex((item) => item.id === row.id);
          if (index >= 0) devices[index] = row;
          else devices.push(row);
          return json([row]);
        }
        if (method === "PATCH") return new Response(null, { status: 204 });
        if (method === "DELETE") return new Response(null, { status: 204 });
      }

      if (route.startsWith("object/")) return new Response(null, { status: 200 });

      return new Response("not found", { status: 404 });
    },
    async storage(path, init) {
      calls.push({ path: `storage/${path}`, method: (init.method ?? "GET").toUpperCase() });
      if (path.startsWith("object/sign/")) {
        return json({ signedURL: "/object/sign/campaigns/x?token=abc" });
      }
      return new Response(null, { status: 200 });
    },
  };

  function userForToken(bearer?: string): string {
    if (!bearer) return "";
    const payload = bearer.split(".")[1];
    if (!payload) return "";
    try {
      return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string }).sub ?? "";
    } catch {
      return "";
    }
  }

  // Mutable on purpose: granting the reviewer role changes what the *next*
  // token issuance carries, which is the case `reviewerSession` exists for.
  const roles = new Map<string, string>([["admin@example.com", "admin"]]);
  const roleFor = (email: string) => roles.get(email) ?? "authenticated";

  function grant(email: string, id: string): UpstreamSession {
    return {
      accessToken: token(roleFor(email)),
      refreshToken: `refresh:${email}`,
      expiresAt: Date.now() + 3_600_000,
      user: { id, email, metadata: {} },
    };
  }

  return {
    upstream,
    calls,
    users,
    booths,
    devices,
    events,
    campaigns,
    roles,
    refreshCount: () => refreshCount,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function config(overrides: Record<string, string> = {}) {
  return readBffConfig({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    BFF_CSRF_SECRET: "s".repeat(48),
    BFF_ALLOWED_ORIGINS: ORIGIN,
    BFF_SESSION_KEY: Buffer.alloc(32, 7).toString("base64"),
    BFF_SESSION_STORE: "memory",
    ...overrides,
  });
}

interface Harness {
  handler: (request: Request) => Promise<Response>;
  fake: ReturnType<typeof createFakeUpstream>;
  clock: { now: number };
}

function harness(overrides: Record<string, string> = {}): Harness {
  const fake = createFakeUpstream();
  const clock = { now: Date.now() };
  const handler = createBffRouter({
    config: config(overrides),
    sessions: createMemorySessionStore(() => clock.now),
    upstream: fake.upstream,
    limiter: createRateLimiter({ clock: () => clock.now }),
    clock: () => clock.now,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { handler, fake, clock };
}

function request(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; csrf?: string; origin?: string | null; contentType?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers();
  if (init.origin !== null) headers.set("Origin", init.origin ?? ORIGIN);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.csrf) headers.set("X-CSRF-Token", init.csrf);
  if (init.body !== undefined) headers.set("Content-Type", init.contentType ?? "application/json");
  for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key, value);
  return new Request(`${BASE}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function sessionCookie(response: Response): string {
  const header = response.headers.getSetCookie()[0];
  expect(header).toBeTruthy();
  return header.split(";")[0];
}

describe("BFF routing", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("answers health checks without a session", async () => {
    const response = await h.handler(request("/healthz", { origin: null }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, store: "memory" });
  });

  it("returns 404 outside its mount point", async () => {
    const response = await h.handler(new Request(`${ORIGIN}/other`));
    expect(response.status).toBe(404);
  });

  it("signs in and issues an HttpOnly, Secure, Lax, __Host- cookie with no token in the body", async () => {
    const response = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    expect(response.status).toBe(200);
    const header = response.headers.getSetCookie()[0];
    expect(header).toMatch(/^__Host-rf_session=/);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.account).toMatchObject({ email: "owner@example.com", source: "bff" });
    expect(typeof body.csrfToken).toBe("string");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh");
    // A JWT header is `eyJ…`; its presence would mean a token leaked.
    expect(serialized).not.toMatch(/eyJ/);
  });

  it("reports the signed-in account from the cookie alone", async () => {
    const login = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    const cookie = sessionCookie(login);
    const response = await h.handler(request("/session", { cookie, origin: null }));
    const body = (await response.json()) as { account: { email: string }; csrfToken: string };
    expect(body.account.email).toBe("owner@example.com");
    expect(body.csrfToken).toHaveLength(43);
  });

  it("treats a malformed cookie as no session", async () => {
    const response = await h.handler(request("/session", { cookie: "__Host-rf_session=not-a-token", origin: null }));
    expect(await response.json()).toMatchObject({ account: null, csrfToken: null });
  });

  it("rejects a state-changing request without a CSRF token", async () => {
    const login = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    const cookie = sessionCookie(login);
    const response = await h.handler(
      request("/campaigns/camp_x", { method: "PUT", cookie, body: { id: "camp_x", title: "New" } }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("CSRF") });
  });

  it("rejects a CSRF token minted for a different session", async () => {
    const first = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    const second = await h.handler(
      request("/auth/login", { body: { email: "admin@example.com", password: "correct horse battery" } }),
    );
    const firstBody = (await first.json()) as { csrfToken: string };
    const cookie = sessionCookie(second);
    const response = await h.handler(
      request("/campaigns/camp_x", { method: "PUT", cookie, csrf: firstBody.csrfToken, body: { id: "camp_x", title: "New" } }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a cross-origin write", async () => {
    const login = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    const cookie = sessionCookie(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const response = await h.handler(
      request("/campaigns/camp_x", {
        method: "PUT",
        cookie,
        csrf: csrfToken,
        origin: "https://evil.example",
        body: { id: "camp_x", title: "New" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Cross-origin") });
  });

  it("rejects a cross-site Sec-Fetch-Site even without an Origin header", async () => {
    const response = await h.handler(
      request("/auth/login", {
        origin: null,
        headers: { "Sec-Fetch-Site": "cross-site" },
        body: { email: "owner@example.com", password: "correct horse battery" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a non-JSON content type", async () => {
    const response = await h.handler(
      request("/auth/login", {
        body: { email: "owner@example.com", password: "correct horse battery" },
        contentType: "text/plain",
      }),
    );
    expect(response.status).toBe(415);
  });

  it("rate limits repeated sign-in attempts", async () => {
    const limit = config().authLimit.max;
    const attempts = [];
    for (let index = 0; index <= limit; index += 1) {
      attempts.push(
        await h.handler(request("/auth/login", { body: { email: "owner@example.com", password: "wrong password" } })),
      );
    }
    expect(attempts.slice(0, limit).every((response) => response.status === 401)).toBe(true);
    expect(attempts[limit].status).toBe(429);
  });

  it("logs out, expires the cookie and revokes the session", async () => {
    const login = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    const cookie = sessionCookie(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };

    const logout = await h.handler(request("/auth/logout", { method: "POST", cookie, csrf: csrfToken }));
    expect(logout.status).toBe(200);
    expect(logout.headers.getSetCookie()[0]).toContain("Max-Age=0");

    const after = await h.handler(request("/session", { cookie, origin: null }));
    expect(await after.json()).toMatchObject({ account: null });
  });

  it("rotates the cookie on refresh and invalidates the previous one", async () => {
    const login = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    const cookie = sessionCookie(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };

    const refreshed = await h.handler(request("/auth/refresh", { method: "POST", cookie, csrf: csrfToken }));
    expect(refreshed.status).toBe(200);
    const rotated = sessionCookie(refreshed);
    expect(rotated).not.toBe(cookie);

    expect((await (await h.handler(request("/session", { cookie, origin: null }))).json()) as { account: unknown }).toMatchObject({ account: null });
    expect(((await (await h.handler(request("/session", { cookie: rotated, origin: null }))).json()) as { account: unknown }).account).not.toBeNull();
  });

  it("expires an idle session", async () => {
    const login = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    const cookie = sessionCookie(login);
    h.clock.now += (config().sessionIdleSeconds + 1) * 1000;
    const response = await h.handler(request("/session", { cookie, origin: null }));
    expect(await response.json()).toMatchObject({ account: null });
    expect(response.headers.getSetCookie()[0]).toContain("Max-Age=0");
  });

  it("refreshes an expiring upstream token before using it", async () => {
    const login = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    const cookie = sessionCookie(login);
    h.clock.now += 3_600_000; // past the token's expiry, inside the session idle window
    const body = (await (await h.handler(request("/session", { cookie, origin: null }))).json()) as { account: unknown };
    expect(body.account).not.toBeNull();
    expect(h.fake.refreshCount()).toBeGreaterThan(0);
  });
});

describe("BFF campaign access", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  async function signIn(email: string) {
    const response = await h.handler(
      request("/auth/login", { body: { email, password: "correct horse battery" } }),
    );
    const { csrfToken } = (await response.json()) as { csrfToken: string };
    return { cookie: sessionCookie(response), csrf: csrfToken };
  }

  it("serves only approved campaigns to anonymous readers", async () => {
    const response = await h.handler(request("/campaigns", { origin: null }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { campaigns: Array<{ id: string }> };
    expect(body.campaigns.map((campaign) => campaign.id)).toEqual(["camp_approved"]);

    const upstreamCall = h.fake.calls.find((call) => call.path.startsWith("public_campaigns?"));
    expect(upstreamCall?.path).toContain("approval_state=eq.approved");
    expect(upstreamCall?.token).toBe("anon-key");
  });

  it("never returns a draft through the public single-campaign route", async () => {
    const response = await h.handler(request("/campaigns/camp_draft", { origin: null }));
    expect(await response.json()).toMatchObject({ campaign: null });
  });

  it("requires a session to write", async () => {
    const response = await h.handler(request("/campaigns/camp_x", { method: "PUT", body: { id: "camp_x", title: "New" } }));
    expect(response.status).toBe(401);
  });

  it("lets the database stamp the owner instead of trusting the client", async () => {
    const { cookie, csrf } = await signIn("owner@example.com");
    const response = await h.handler(
      request("/campaigns/camp_new", {
        method: "PUT",
        cookie,
        csrf,
        body: { id: "camp_new", title: "New", mediaType: "image", displaySeconds: 10, enabled: true, approved: false },
      }),
    );
    expect(response.status).toBe(200);
    const insert = h.fake.calls.filter((call) => call.path.startsWith("campaigns?") && call.method === "POST").at(-1);
    const row = (insert?.body as Array<Record<string, unknown>>)[0];
    // `owner` defaults to auth.uid() in the database (0005) — a client-supplied
    // value would be an ownership-transfer primitive.
    expect(row).not.toHaveProperty("owner");
    expect(row).toMatchObject({ approval_state: "draft" });
  });

  it("refuses to let a non-reviewer approve a campaign", async () => {
    const { cookie, csrf } = await signIn("owner@example.com");
    const response = await h.handler(
      request("/campaigns/camp_draft", {
        method: "PUT",
        cookie,
        csrf,
        body: { id: "camp_draft", title: "Draft", approved: true, mediaType: "image", displaySeconds: 10, enabled: true },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("reviewer") });
  });

  it("lets a reviewer record a decision", async () => {
    const { cookie, csrf } = await signIn("admin@example.com");
    const response = await h.handler(
      request("/campaigns/camp_draft/approval", { method: "POST", cookie, csrf, body: { state: "approved", note: "ok" } }),
    );
    expect(response.status).toBe(200);
    const audit = h.fake.calls.find((call) => call.path === "approval_audit" && call.method === "POST");
    expect((audit?.body as Array<Record<string, unknown>>)[0]).toMatchObject({ campaign_id: "camp_draft", state: "approved" });
  });

  it("picks up a reviewer role granted after sign-in, without a re-login", async () => {
    // Sign in first, then grant (the order the runbook produces).
    const { cookie, csrf } = await signIn("owner@example.com");
    h.fake.roles.set("owner@example.com", "admin");

    const response = await h.handler(
      request("/campaigns/camp_draft/approval", { method: "POST", cookie, csrf, body: { state: "approved", note: "ok" } }),
    );
    expect(response.status).toBe(200);
    expect(h.fake.refreshCount()).toBeGreaterThan(0);
  });

  it("still refuses a reviewer action from an account with no role", async () => {
    const { cookie, csrf } = await signIn("owner@example.com");
    const response = await h.handler(
      request("/campaigns/camp_draft/approval", { method: "POST", cookie, csrf, body: { state: "approved" } }),
    );
    expect(response.status).toBe(403);
    // The reissue must not end the session on a refused decision.
    const session = await h.handler(request("/session", { cookie, origin: null }));
    expect(((await session.json()) as { account: unknown }).account).not.toBeNull();
  });

  it("rejects malformed campaign ids without reaching the database", async () => {
    const before = h.fake.calls.length;
    const response = await h.handler(request("/campaigns/%2E%2E%2Fsecret", { origin: null }));
    expect(response.status).toBe(400);
    expect(h.fake.calls.length).toBe(before);
  });
});

describe("BFF public writes", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  const event = (campaignId: string) => ({
    id: "evt_1",
    campaignId,
    deviceId: "dev_1",
    kind: "proof-of-play",
    at: Date.now(),
  });

  it("accepts display events for approved campaigns", async () => {
    const response = await h.handler(request("/events", { body: { events: [event("camp_approved")] } }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: 1 });
  });

  it("refuses display events for drafts", async () => {
    const response = await h.handler(request("/events", { body: { events: [event("camp_draft")] } }));
    expect(response.status).toBe(403);
  });

  it("rejects an unknown event kind", async () => {
    const response = await h.handler(
      request("/events", { body: { events: [{ ...event("camp_approved"), kind: "exfiltrate" }] } }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a timestamp far outside the accepted window", async () => {
    const response = await h.handler(
      request("/events", { body: { events: [{ ...event("camp_approved"), at: Date.now() - 40 * 24 * 3600 * 1000 }] } }),
    );
    expect(response.status).toBe(400);
  });

  it("resolves a pair code without exposing the booth", async () => {
    h.fake.booths.push({ id: "booth_1", owner: "user-1", name: "Owner booth", email: "owner@example.com", phone: "0400", city: "Sydney", pair_code: "ABC123", front_pair_code: "DEF456" });
    const response = await h.handler(request("/public/pair/abc-123", { origin: null }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "ABC123", verified: true, position: "rear", account: null });
    expect(JSON.stringify(body)).not.toContain("owner@example.com");
    expect(JSON.stringify(body)).not.toContain("0400");
    expect(JSON.stringify(body)).not.toContain("Sydney");
  });

  it("rate limits pair code lookups", async () => {
    const statuses = [];
    for (let index = 0; index < 22; index += 1) {
      statuses.push((await h.handler(request("/public/pair/ABC123", { origin: null }))).status);
    }
    expect(statuses).toContain(429);
  });
});

describe("BFF manifests", () => {
  it("signs server-side and verifies with the same key", async () => {
    const h = harness({ BFF_MANIFEST_SECRET: "manifest-secret" });
    const login = await h.handler(
      request("/auth/login", { body: { email: "owner@example.com", password: "correct horse battery" } }),
    );
    const cookie = sessionCookie(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };

    const issued = await h.handler(request("/manifest", { method: "POST", cookie, csrf: csrfToken, body: {} }));
    expect(issued.status).toBe(200);
    const { manifest } = (await issued.json()) as { manifest: { signature?: string; entries: unknown[] } };
    expect(manifest.signature).toBeTruthy();

    const verdict = await h.handler(request("/manifest/verify", { body: { manifest } }));
    expect(await verdict.json()).toMatchObject({ valid: true });
  });
});
