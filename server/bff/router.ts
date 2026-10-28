/**
 * BFF request router.
 *
 * A pure `Request → Response` handler: no sockets, no globals, no ambient
 * state. `node.ts` adapts it to `http.createServer`, and the tests call it
 * directly, so what is exercised in CI is exactly what runs in production.
 *
 * Security properties this file is responsible for:
 *
 *   * the browser never receives an upstream token — only an opaque `HttpOnly`
 *     cookie and a derived CSRF token;
 *   * every state-changing request needs a same-origin `Origin` (or an explicit
 *     `Sec-Fetch-Site: same-origin`) **and** the CSRF token bound to the session;
 *   * anonymous reads are restricted to the public projection (approved
 *     campaigns) even when the database policies have not been migrated yet;
 *   * upstream error text is mapped to a small public vocabulary, so database
 *     errors cannot be used as an oracle;
 *   * authentication, API and public traffic are separately rate limited.
 */

import type {
  CampaignApprovalState,
  CommercialCampaign,
  PlaylistManifest,
  TerminalBinding,
} from "../../src/types";
import { imageObjectPath } from "../../src/lib/backend/imageShards";
import { issueManifest, verifyManifest } from "../../src/lib/backend/manifest";
import { normalizePairCode } from "../../src/lib/id";
import { createRateLimiter, type RateLimiter } from "../limits/rateLimit";
import type { BffConfig } from "./config";
import { clearSessionCookie, readCookie, serializeSessionCookie, sessionCookieName } from "./cookies";
import { sessionIsExpired, type SessionAccount, type SessionRecord, type SessionStore } from "./sessions";
import { csrfFor, hashToken, looksLikeSessionToken, newSessionToken, safeEqual } from "./tokens";
import { UpstreamError, type Upstream, type UpstreamSession } from "./upstream";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface BffLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface BffDeps {
  config: BffConfig;
  sessions: SessionStore;
  upstream: Upstream;
  limiter?: RateLimiter;
  clock?: () => number;
  logger?: BffLogger;
  /** Mount point, default `/bff`. */
  basePath?: string;
  version?: string;
}

export type BffHandler = (request: Request) => Promise<Response>;

const silentLogger: BffLogger = { info() {}, warn() {}, error() {} };

const PAIR_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CAMPAIGN_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const DEVICE_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const EVENT_KINDS = new Set(["proof-of-play", "qr-scan", "referral-conversion"]);
const APPROVAL_STATES = new Set(["draft", "pending", "approved", "rejected"]);
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
]);

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function baseHeaders(config: BffConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
  if (config.secureCookies) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}, config?: BffConfig): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(config ? baseHeaders(config) : {}),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function errorResponse(status: number, message: string, config: BffConfig, extra: Record<string, string> = {}): Response {
  return json({ error: message }, status, extra, config);
}

function tooMany(config: BffConfig, retryAfterSeconds: number): Response {
  return errorResponse(429, "Too many requests. Try again shortly.", config, {
    "Retry-After": String(retryAfterSeconds),
  });
}

function sanitizeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : "";
}

function mintPairCode(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += PAIR_CODE_ALPHABET[byte % PAIR_CODE_ALPHABET.length];
  return code;
}

/** exp/role from a token we obtained from GoTrue and keep server-side. */
export function decodeAccessToken(token: string): { exp?: number; role?: string } {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
      role?: string;
      app_metadata?: { role?: string };
    };
    return { exp: claims.exp, role: claims.app_metadata?.role ?? claims.role };
  } catch {
    return {};
  }
}

function isAdminToken(token: string): boolean {
  return decodeAccessToken(token).role === "admin";
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

export function createBffRouter(deps: BffDeps): BffHandler {
  const { config, sessions, upstream } = deps;
  const clock = deps.clock ?? Date.now;
  const logger = deps.logger ?? silentLogger;
  const basePath = (deps.basePath ?? "/bff").replace(/\/$/, "");
  const limiter: RateLimiter = deps.limiter ?? createRateLimiter({ clock });
  const version = deps.version ?? "bff-1";
  const cookieName = sessionCookieName(config.secureCookies);

  /* ---------------------------------------------------------------- *
   * Request-level guards
   * ---------------------------------------------------------------- */

  function clientKey(request: Request): string {
    if (config.trustProxy) {
      const forwarded = request.headers.get("x-forwarded-for");
      const first = forwarded?.split(",")[0]?.trim();
      if (first) return first;
    }
    // Without a trusted proxy header every anonymous caller shares one bucket.
    // That is deliberately the conservative direction: a shared limit degrades
    // throughput, a spoofable one degrades nothing.
    return "untrusted";
  }

  async function limit(request: Request, bucket: string, rule: { max: number; windowSeconds: number }, suffix = ""): Promise<Response | null> {
    const result = await limiter.check(`${bucket}:${clientKey(request)}${suffix}`, rule.max, rule.windowSeconds);
    if (result.allowed) return null;
    return tooMany(config, result.retryAfterSeconds);
  }

  /**
   * CSRF gate for state-changing requests.
   *
   * Two independent conditions:
   *   1. the request must come from an allowed origin (exact match), or carry
   *      `Sec-Fetch-Site: same-origin`, or have no browser provenance at all
   *      (curl, server-to-server — not a CSRF vector);
   *   2. when a session exists, the request must carry the CSRF token derived
   *      from that session.
   */
  function checkOrigin(request: Request): Response | null {
    const origin = request.headers.get("origin");
    if (origin) {
      if (!config.allowedOrigins.includes(origin)) {
        logger.warn("bff: rejected cross-origin request", { origin });
        return errorResponse(403, "Cross-origin request rejected.", config);
      }
      return null;
    }
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      logger.warn("bff: rejected cross-site request", { site });
      return errorResponse(403, "Cross-site request rejected.", config);
    }
    return null;
  }

  function checkCsrf(request: Request, tokenHash: string): Response | null {
    const provided = request.headers.get("x-csrf-token") ?? "";
    const expected = csrfFor(tokenHash, config.csrfSecret);
    if (!provided || !safeEqual(provided, expected)) {
      return errorResponse(403, "Missing or invalid CSRF token. Reload the page and try again.", config);
    }
    return null;
  }

  /**
   * Require a JSON content type for JSON endpoints. A cross-site HTML form can
   * only send `application/x-www-form-urlencoded`, `multipart/form-data` or
   * `text/plain`, so this closes the "simple request" CSRF class outright.
   */
  function checkJsonContentType(request: Request): Response | null {
    const type = (request.headers.get("content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/json")) {
      return errorResponse(415, "Expected application/json.", config);
    }
    return null;
  }

  async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpError(413, "Request body is too large.");
    }
    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new HttpError(413, "Request body is too large.");
    if (buffer.byteLength === 0) return {};
    try {
      return JSON.parse(buffer.toString("utf8")) as unknown;
    } catch {
      throw new HttpError(400, "Request body is not valid JSON.");
    }
  }

  /* ---------------------------------------------------------------- *
   * Session handling
   * ---------------------------------------------------------------- */

  interface ResolvedSession {
    record: SessionRecord;
    tokenHash: string;
  }

  async function resolveSession(request: Request): Promise<ResolvedSession | null> {
    const token = readCookie(request.headers.get("cookie"), cookieName);
    if (!looksLikeSessionToken(token)) return null;
    const tokenHash = hashToken(token);
    const record = await sessions.get(tokenHash);
    if (!record) return null;
    if (sessionIsExpired(record, clock(), config.sessionIdleSeconds)) {
      await sessions.revoke(tokenHash);
      return null;
    }

    // Touch at most once a minute: the idle timeout does not need per-request
    // write amplification, and a busy display would otherwise rewrite the row
    // on every poll.
    if (clock() - record.lastSeenAt > 60_000) {
      const touched = { ...record, lastSeenAt: clock() };
      await sessions.update(touched);
      return { record: touched, tokenHash };
    }
    return { record, tokenHash };
  }

  /** Refresh the upstream token when it is close to expiring. */
  async function freshSession(record: SessionRecord): Promise<SessionRecord> {
    if (record.accessExpiresAt - clock() > config.refreshSkewSeconds * 1000) return record;
    try {
      const refreshed = await upstream.refresh(record.refreshToken);
      const next: SessionRecord = {
        ...record,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accessExpiresAt: refreshed.expiresAt,
        lastSeenAt: clock(),
      };
      await sessions.update(next);
      return next;
    } catch (error) {
      logger.warn("bff: upstream refresh failed, ending the session", { reason: String(error) });
      await sessions.revoke(record.id);
      throw new HttpError(401, "Your session expired. Sign in again.");
    }
  }

  /**
   * Ask GoTrue for a new access token without touching the session on failure.
   *
   * Used for one thing: a role granted a minute ago lives in `app_metadata`, and
   * the token in the session was issued before it. Refreshing re-derives the
   * claims from the current user record, so the very next reviewer action works
   * without making the operator sign out and back in. A transient upstream
   * failure returns null — it must not end the session, which is what the
   * expiry path (correctly) does.
   */
  async function reissueSession(record: SessionRecord): Promise<SessionRecord | null> {
    try {
      const refreshed = await upstream.refresh(record.refreshToken);
      const next: SessionRecord = {
        ...record,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accessExpiresAt: refreshed.expiresAt,
        lastSeenAt: clock(),
      };
      await sessions.update(next);
      return next;
    } catch (error) {
      logger.warn("bff: could not reissue the upstream token", { reason: String(error) });
      return null;
    }
  }

  /**
   * The session to decide a reviewer question with: current token, reissued once
   * if it does not carry the reviewer claim yet.
   */
  async function reviewerSession(record: SessionRecord): Promise<{ record: SessionRecord; isReviewer: boolean }> {
    if (isAdminToken(record.accessToken)) return { record, isReviewer: true };
    const reissued = await reissueSession(record);
    if (!reissued) return { record, isReviewer: false };
    return { record: reissued, isReviewer: isAdminToken(reissued.accessToken) };
  }

  function setCookieHeader(token: string, maxAgeSeconds: number): string {
    return serializeSessionCookie(token, {
      secure: config.secureCookies,
      sameSite: config.cookieSameSite,
      maxAgeSeconds,
    });
  }

  function clearCookieHeader(): string {
    return clearSessionCookie({ secure: config.secureCookies, sameSite: config.cookieSameSite });
  }

  /* ---------------------------------------------------------------- *
   * Accounts
   * ---------------------------------------------------------------- */

  interface BoothRow {
    id: string;
    owner?: string | null;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    city?: string | null;
    pair_code: string;
    front_pair_code?: string | null;
    created_at?: string | null;
  }

  function accountFrom(session: UpstreamSession, booth: BoothRow | null): SessionAccount {
    const metadata = session.user.metadata ?? {};
    const email = booth?.email || session.user.email || "";
    return {
      id: booth?.owner || session.user.id,
      name: booth?.name || sanitizeText(metadata.name, 120) || email || "Driver",
      email,
      phone: booth?.phone || sanitizeText(metadata.phone, 40),
      city: booth?.city || sanitizeText(metadata.city, 80),
      pairCode: booth?.pair_code ?? "",
      frontPairCode: booth?.front_pair_code ?? undefined,
      createdAt: booth?.created_at ?? new Date(clock()).toISOString(),
      source: "bff",
    };
  }

  async function restJson<T>(path: string, init: RequestInit, token: string): Promise<T | null> {
    const response = await upstream.rest(path, init, token);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.warn("bff: upstream REST call failed", { path: path.split("?")[0], status: response.status, detail: detail.slice(0, 200) });
      return null;
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  /** The booth row for a user, minting one (with fresh pair codes) on first use. */
  async function ensureBooth(session: UpstreamSession): Promise<BoothRow | null> {
    const ownerId = session.user.id;
    if (!ownerId) return null;
    const token = session.accessToken;
    const existing = await restJson<BoothRow[]>(
      `booths?owner=eq.${encodeURIComponent(ownerId)}&select=*&limit=1`,
      { headers: { Accept: "application/json" } },
      token,
    );
    if (existing?.[0]) return existing[0];

    const metadata = session.user.metadata ?? {};
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const created = await restJson<BoothRow[]>(
        "booths?select=*",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify([
            {
              owner: ownerId,
              name: sanitizeText(metadata.name, 120) || session.user.email || "Driver",
              email: session.user.email || null,
              phone: sanitizeText(metadata.phone, 40) || null,
              city: sanitizeText(metadata.city, 80) || null,
              pair_code: mintPairCode(),
              front_pair_code: mintPairCode(),
            },
          ]),
        },
        token,
      );
      if (created?.[0]) return created[0];
    }
    return null;
  }

  interface CreatedSession {
    token: string;
    record: SessionRecord;
    account: SessionAccount;
  }

  async function createSession(session: UpstreamSession): Promise<CreatedSession> {
    const booth = await ensureBooth(session).catch((error) => {
      logger.warn("bff: booth lookup failed", { reason: String(error) });
      return null;
    });
    const token = newSessionToken();
    const now = clock();
    const record: SessionRecord = {
      id: hashToken(token),
      userId: session.user.id,
      email: session.user.email,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessExpiresAt: session.expiresAt,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + config.sessionTtlSeconds * 1000,
      account: accountFrom(session, booth),
    };
    await sessions.create(record);
    return { token, record, account: record.account };
  }

  function sessionPayload(record: SessionRecord, csrf: string, account: SessionAccount) {
    return {
      account,
      csrfToken: csrf,
      expiresAt: Math.min(record.absoluteExpiresAt, record.lastSeenAt + config.sessionIdleSeconds * 1000),
    };
  }

  /* ---------------------------------------------------------------- *
   * Campaign mapping (mirrors src/lib/backend/supabase.ts)
   * ---------------------------------------------------------------- */

  interface CampaignRow {
    id: string;
    title: string;
    payload: CommercialCampaign;
    updated_at: string;
    approval_state: string | null;
    compliance_mode?: string | null;
  }

  function approvalStateFor(campaign: CommercialCampaign): string {
    return campaign.approval?.state ?? (campaign.approved ? "approved" : "draft");
  }

  /**
   * The row a write sends. `owner` is deliberately absent: the column defaults
   * to `auth.uid()` (migration 0005), so an insert is owned by its creator and
   * an update cannot move a row to a different owner — which is exactly the
   * mistake a reviewer approving someone else's campaign would otherwise make.
   */
  function campaignRowBody(campaign: CommercialCampaign): Record<string, unknown> {
    const state = approvalStateFor(campaign);
    // Keep the payload's own approval flags in step with the column the view and
    // the display actually filter on, so the two can never disagree.
    const payload: CommercialCampaign = {
      ...campaign,
      approved: state === "approved",
      approval: { ...campaign.approval, state: state as CampaignApprovalState },
      updatedAt: clock(),
    };
    return {
      id: campaign.id,
      title: campaign.title,
      approval_state: state,
      ...(campaign.complianceMode === "unregulated" ? { compliance_mode: "unregulated" } : {}),
      payload,
      updated_at: new Date(clock()).toISOString(),
    };
  }

  function readCampaign(body: unknown): CommercialCampaign {
    if (!body || typeof body !== "object") throw new HttpError(400, "Expected a campaign object.");
    const candidate = body as CommercialCampaign;
    if (typeof candidate.id !== "string" || !CAMPAIGN_ID.test(candidate.id)) {
      throw new HttpError(400, "Campaign id is missing or malformed.");
    }
    if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) {
      throw new HttpError(400, "Campaign title is required.");
    }
    return candidate;
  }

  /* ---------------------------------------------------------------- *
   * Route handlers
   * ---------------------------------------------------------------- */

  async function handleSession(request: Request, resolved: ResolvedSession | null): Promise<Response> {
    if (!resolved) {
      // A cookie that no longer resolves is expired or revoked: clear it so the
      // browser stops sending a dead credential on every request.
      const hadCookie = Boolean(readCookie(request.headers.get("cookie"), cookieName));
      return json(
        { account: null, csrfToken: null, expiresAt: null },
        200,
        hadCookie ? { "Set-Cookie": clearCookieHeader() } : {},
        config,
      );
    }
    const record = await freshSession(resolved.record).catch(() => null);
    if (!record) {
      return json({ account: null, csrfToken: null, expiresAt: null }, 200, { "Set-Cookie": clearCookieHeader() }, config);
    }
    return json(
      sessionPayload(record, csrfFor(resolved.tokenHash, config.csrfSecret), record.account),
      200,
      {},
      config,
    );
  }

  async function handleSignUp(request: Request): Promise<Response> {
    const limited = await limit(request, "auth", config.authLimit);
    if (limited) return limited;
    const typeError = checkJsonContentType(request);
    if (typeError) return typeError;

    const body = (await readJson(request)) as Record<string, unknown>;
    const email = sanitizeText(body.email, 200).trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const name = sanitizeText(body.name, 120).trim();

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return errorResponse(400, "Enter a valid email address.", config);
    if (password.length < 8) return errorResponse(400, "Choose a password with at least 8 characters.", config);
    if (password.length > 200) return errorResponse(400, "That password is too long.", config);
    if (!name) return errorResponse(400, "Enter your name.", config);

    try {
      const outcome = await upstream.signUp({
        email,
        password,
        data: { name, phone: sanitizeText(body.phone, 40), city: sanitizeText(body.city, 80) },
      });
      if (outcome.alreadyRegistered) {
        return errorResponse(409, "An account already exists for that email. Log in instead.", config);
      }
      if (!outcome.session) {
        return json(
          { account: null, csrfToken: null, expiresAt: null, message: "Account created. Open the confirmation email, then log in on this terminal." },
          202,
          {},
          config,
        );
      }
      const created = await createSession(outcome.session);
      return json(sessionPayload(created.record, csrfFor(created.record.id, config.csrfSecret), created.account), 201, {
        "Set-Cookie": setCookieHeader(created.token, config.sessionTtlSeconds),
      }, config);
    } catch (error) {
      return authError(error);
    }
  }

  async function handleLogin(request: Request): Promise<Response> {
    const limited = await limit(request, "auth", config.authLimit);
    if (limited) return limited;
    const typeError = checkJsonContentType(request);
    if (typeError) return typeError;

    const body = (await readJson(request)) as Record<string, unknown>;
    const email = sanitizeText(body.email, 200).trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) return errorResponse(400, "Enter your email and password.", config);

    // A per-email bucket stops a distributed password spray against one account.
    const emailLimited = await limit(request, "auth-email", { max: config.authLimit.max, windowSeconds: config.authLimit.windowSeconds }, `:${hashToken(email)}`);
    if (emailLimited) return emailLimited;

    try {
      const session = await upstream.signIn(email, password);
      const created = await createSession(session);
      return json(sessionPayload(created.record, csrfFor(created.record.id, config.csrfSecret), created.account), 200, {
        "Set-Cookie": setCookieHeader(created.token, config.sessionTtlSeconds),
      }, config);
    } catch (error) {
      return authError(error);
    }
  }

  async function handleLogout(request: Request): Promise<Response> {
    const originError = checkOrigin(request);
    if (originError) return originError;
    const resolved = await resolveSession(request);
    if (resolved) {
      const csrfError = checkCsrf(request, resolved.tokenHash);
      if (csrfError) return csrfError;
      await sessions.revoke(resolved.tokenHash);
      await upstream.logout(resolved.record.accessToken).catch(() => undefined);
    }
    return json({ ok: true, account: null }, 200, { "Set-Cookie": clearCookieHeader() }, config);
  }

  async function handleRefresh(request: Request): Promise<Response> {
    const originError = checkOrigin(request);
    if (originError) return originError;
    const resolved = await resolveSession(request);
    if (!resolved) return errorResponse(401, "Not signed in.", config, { "Set-Cookie": clearCookieHeader() });
    const csrfError = checkCsrf(request, resolved.tokenHash);
    if (csrfError) return csrfError;

    let record: SessionRecord;
    try {
      record = await freshSession(resolved.record);
    } catch {
      return errorResponse(401, "Your session expired. Sign in again.", config, { "Set-Cookie": clearCookieHeader() });
    }

    // Rotate the cookie token on every explicit refresh: a stolen cookie is
    // useful only until the next refresh, and the old hash is removed.
    const token = newSessionToken();
    const next: SessionRecord = { ...record, id: hashToken(token), lastSeenAt: clock() };
    await sessions.create(next);
    await sessions.revoke(resolved.tokenHash);

    return json(sessionPayload(next, csrfFor(next.id, config.csrfSecret), next.account), 200, {
      "Set-Cookie": setCookieHeader(token, config.sessionTtlSeconds),
    }, config);
  }

  /* ------------------------------------------------ campaigns ------ */

  function isoOrUndefined(value: string | null): string | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return new Date(parsed).toISOString();
  }

  async function handleCampaignList(request: Request, url: URL, resolved: ResolvedSession | null): Promise<Response> {
    const limited = await limit(request, resolved ? "api" : "public", resolved ? config.apiLimit : config.publicLimit);
    if (limited) return limited;

    const params = new URLSearchParams({ select: "*", order: "updated_at.desc" });
    const since = isoOrUndefined(url.searchParams.get("since"));
    if (since) params.set("updated_at", `gt.${since}`);
    const limitParam = Number(url.searchParams.get("limit") ?? "0");
    if (Number.isFinite(limitParam) && limitParam > 0) params.set("limit", String(Math.min(limitParam, 200)));
    else params.set("limit", "200");
    // Anonymous readers go to the public projection (migration 0006): approved
    // rows only, consent PII redacted, and no privilege on the base table to
    // widen later. The explicit filter stays as a second line of defence.
    if (!resolved) params.set("approval_state", "eq.approved");

    const table = resolved ? "campaigns" : "public_campaigns";
    const token = resolved ? (await freshSession(resolved.record)).accessToken : config.anonKey;
    const rows = await restJson<CampaignRow[]>(`${table}?${params.toString()}`, { headers: { Accept: "application/json" } }, token);
    if (!rows) return errorResponse(502, "The campaign service is unavailable.", config);
    return json({ campaigns: rows.map((row) => row.payload).filter(Boolean) }, 200, {}, config);
  }

  async function handleCampaignGet(request: Request, id: string, resolved: ResolvedSession | null): Promise<Response> {
    const limited = await limit(request, resolved ? "api" : "public", resolved ? config.apiLimit : config.publicLimit);
    if (limited) return limited;
    if (!CAMPAIGN_ID.test(id)) return errorResponse(400, "Malformed campaign id.", config);

    const filter = new URLSearchParams({ id: `eq.${id}`, select: "*", limit: "1" });
    if (!resolved) filter.set("approval_state", "eq.approved");
    const table = resolved ? "campaigns" : "public_campaigns";
    const token = resolved ? (await freshSession(resolved.record)).accessToken : config.anonKey;
    const rows = await restJson<CampaignRow[]>(`${table}?${filter.toString()}`, { headers: { Accept: "application/json" } }, token);
    if (!rows) return errorResponse(502, "The campaign service is unavailable.", config);
    return json({ campaign: rows[0]?.payload ?? null }, 200, {}, config);
  }

  async function handleCampaignUpsert(request: Request, id: string, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    const typeError = checkJsonContentType(request);
    if (typeError) return typeError;

    const campaign = readCampaign({ ...(await readJson(request) as Record<string, unknown>), id });
    const state = approvalStateFor(campaign);
    let record = await freshSession(resolved.record);
    if (state === "approved" || state === "rejected") {
      const review = await reviewerSession(record);
      if (!review.isReviewer) return errorResponse(403, "Only a reviewer can approve or reject a campaign.", config);
      record = review.record;
    }

    const rows = await restJson<CampaignRow[]>(
      "campaigns?on_conflict=id&select=*",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify([campaignRowBody(campaign)]),
      },
      record.accessToken,
    );
    if (!rows) return errorResponse(409, "That campaign could not be saved. It may belong to another account.", config);
    return json({ campaign: rows[0]?.payload ?? campaign }, 200, {}, config);
  }

  async function handleCampaignDelete(request: Request, id: string, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    if (!CAMPAIGN_ID.test(id)) return errorResponse(400, "Malformed campaign id.", config);
    const record = await freshSession(resolved.record);
    const response = await upstream.rest(`campaigns?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" }, record.accessToken);
    if (!response.ok) return errorResponse(409, "That campaign could not be deleted.", config);
    return json({ ok: true }, 200, {}, config);
  }

  async function handleApproval(request: Request, id: string, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    if (!CAMPAIGN_ID.test(id)) return errorResponse(400, "Malformed campaign id.", config);
    const typeError = checkJsonContentType(request);
    if (typeError) return typeError;

    const body = (await readJson(request)) as Record<string, unknown>;
    const state = sanitizeText(body.state, 20);
    if (!APPROVAL_STATES.has(state)) return errorResponse(400, "Unknown approval state.", config);
    const reviewer = sanitizeText(body.reviewer, 120) || resolved.record.email;
    const note = sanitizeText(body.note, 500) || undefined;

    let record = await freshSession(resolved.record);
    if (state === "approved" || state === "rejected") {
      const review = await reviewerSession(record);
      if (!review.isReviewer) return errorResponse(403, "Only a reviewer can approve or reject a campaign.", config);
      record = review.record;
    }

    const rows = await restJson<CampaignRow[]>(
      `campaigns?id=eq.${encodeURIComponent(id)}&select=*`,
      { headers: { Accept: "application/json" } },
      record.accessToken,
    );
    if (!rows?.[0]) return errorResponse(404, "Campaign not found.", config);

    const existing = rows[0].payload;
    const next: CommercialCampaign = {
      ...existing,
      approved: state === "approved",
      approval: { state: state as CampaignApprovalState, reviewer, note, reviewedAt: clock() },
      updatedAt: clock(),
    };

    const saved = await restJson<CampaignRow[]>(
      "campaigns?on_conflict=id&select=*",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify([campaignRowBody(next)]),
      },
      record.accessToken,
    );
    if (!saved) return errorResponse(409, "That decision could not be saved.", config);

    // The database trigger in 0005 records every transition, so this is a
    // convenience copy of the reviewer's note — and only a reviewer is allowed
    // to insert audit rows, so do not bother the database otherwise.
    if (isAdminToken(record.accessToken)) {
      await upstream
        .rest(
          "approval_audit",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify([{ campaign_id: id, state, reviewer, note: note ?? null, reviewed_at: new Date(clock()).toISOString() }]),
          },
          record.accessToken,
        )
        .catch(() => undefined);
    }

    return json({ campaign: saved[0]?.payload ?? next }, 200, {}, config);
  }

  /* --------------------------------------------------- events ------ */

  function readEventBatch(body: unknown): Array<Record<string, unknown>> {
    const list = (body as { events?: unknown })?.events;
    if (!Array.isArray(list)) throw new HttpError(400, "Expected an events array.");
    if (list.length === 0) return [];
    if (list.length > 50) throw new HttpError(413, "Send at most 50 events per request.");

    const now = clock();
    const rows: Array<Record<string, unknown>> = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") throw new HttpError(400, "Malformed event.");
      const event = entry as Record<string, unknown>;
      const id = sanitizeText(event.id, 128);
      const campaignId = sanitizeText(event.campaignId, 128);
      const deviceId = sanitizeText(event.deviceId, 128);
      const kind = sanitizeText(event.kind, 32);
      if (!id || !campaignId || !deviceId) throw new HttpError(400, "Event is missing an id, campaign or device.");
      // Ids end up inside a PostgREST filter below; keep them to the character
      // set the app mints so a crafted value cannot reshape that filter.
      if (!CAMPAIGN_ID.test(id) || !CAMPAIGN_ID.test(campaignId) || !DEVICE_ID.test(deviceId)) {
        throw new HttpError(400, "Malformed event id.");
      }
      if (!EVENT_KINDS.has(kind)) throw new HttpError(400, "Unknown event kind.");
      const at = Number(event.at);
      if (!Number.isFinite(at) || Math.abs(now - at) > 7 * 24 * 3600 * 1000) {
        throw new HttpError(400, "Event timestamp is out of range.");
      }
      const dwell = event.dwellSeconds === undefined ? null : Number(event.dwellSeconds);
      if (dwell !== null && (!Number.isFinite(dwell) || dwell < 0 || dwell > 86_400)) {
        throw new HttpError(400, "Event dwell time is out of range.");
      }
      const meta = (event.meta ?? {}) as Record<string, unknown>;
      if (JSON.stringify(meta).length > 2_000) throw new HttpError(413, "Event metadata is too large.");
      const pairCode = sanitizeText(event.pairCode, 8);
      rows.push({
        id,
        campaign_id: campaignId,
        device_id: deviceId,
        pair_code: pairCode || null,
        kind,
        at: new Date(at).toISOString(),
        dwell_seconds: dwell,
        meta,
      });
    }
    return rows;
  }

  async function handleEventsSend(request: Request, resolved: ResolvedSession | null): Promise<Response> {
    const limited = await limit(request, resolved ? "api" : "public", resolved ? config.apiLimit : config.publicLimit);
    if (limited) return limited;
    const typeError = checkJsonContentType(request);
    if (typeError) return typeError;

    const rows = readEventBatch(await readJson(request));
    if (rows.length === 0) return json({ accepted: 0 }, 200, {}, config);

    const token = resolved ? (await freshSession(resolved.record)).accessToken : config.anonKey;

    // A display with no session may only report events for approved campaigns.
    // Without this check the public endpoint would be a write primitive for
    // arbitrary campaign ids.
    let accepted = rows;
    if (!resolved) {
      const ids = [...new Set(rows.map((row) => String(row.campaign_id)))];
      const filter = new URLSearchParams({ select: "id", approval_state: "eq.approved", id: `in.(${ids.join(",")})` });
      const approved = await restJson<Array<{ id: string }>>(
        `public_campaigns?${filter.toString()}`,
        { headers: { Accept: "application/json" } },
        token,
      ).catch(() => null);
      const allowedIds = new Set((approved ?? []).map((row) => row.id));
      accepted = rows.filter((row) => allowedIds.has(String(row.campaign_id)));
      if (accepted.length === 0) {
        return errorResponse(403, "Events are only accepted for approved campaigns.", config);
      }
    }

    const response = await upstream.rest(
      "campaign_events",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(accepted),
      },
      token,
    );
    if (!response.ok) {
      logger.warn("bff: event insert rejected", { status: response.status });
      return errorResponse(502, "The event service is unavailable.", config);
    }
    return json({ accepted: accepted.length }, 202, {}, config);
  }

  async function handleEventsList(request: Request, url: URL, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    const record = await freshSession(resolved.record);
    const limitParam = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "60") || 60, 1), 500);
    const response = await upstream.rest(
      `campaign_events?select=*&order=at.desc&limit=${limitParam}`,
      { headers: { Accept: "application/json" } },
      record.accessToken,
    );
    if (!response.ok) return errorResponse(502, "The event service is unavailable.", config);
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    return json(
      {
        events: rows.map((row) => ({
          id: String(row.id),
          campaignId: String(row.campaign_id),
          deviceId: String(row.device_id),
          pairCode: row.pair_code ? String(row.pair_code) : undefined,
          kind: String(row.kind),
          at: new Date(String(row.at)).getTime(),
          dwellSeconds: row.dwell_seconds === null || row.dwell_seconds === undefined ? undefined : Number(row.dwell_seconds),
          meta: (row.meta ?? {}) as Record<string, unknown>,
        })),
      },
      200,
      {},
      config,
    );
  }

  /* -------------------------------------------------- devices ------ */

  interface DeviceRow {
    id: string;
    name: string;
    pair_code: string;
    position: string;
    last_seen?: string | null;
    owner?: string | null;
    device_key?: string | null;
    account_email?: string | null;
    assigned_at?: string | null;
    origin?: string | null;
  }

  function fromDeviceRow(row: DeviceRow): TerminalBinding {
    return {
      id: row.id,
      deviceId: row.device_key ?? row.id,
      deviceName: row.name,
      pairCode: normalizePairCode(row.pair_code),
      position: row.position === "front" ? "front" : "rear",
      accountId: row.owner ?? null,
      accountEmail: row.account_email ?? undefined,
      origin: (row.origin ?? "console") as TerminalBinding["origin"],
      assignedAt: row.assigned_at ? Date.parse(row.assigned_at) : (Date.parse(row.last_seen ?? "") || clock()),
      lastSeen: row.last_seen ? Date.parse(row.last_seen) : undefined,
    };
  }

  async function handleDeviceList(request: Request, url: URL, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    const record = await freshSession(resolved.record);
    const accountId = sanitizeText(url.searchParams.get("accountId"), 128);
    const filter = accountId ? `&owner=eq.${encodeURIComponent(accountId)}` : "";
    const response = await upstream.rest(
      `devices?select=*&order=last_seen.desc${filter}`,
      { headers: { Accept: "application/json" } },
      record.accessToken,
    );
    if (!response.ok) return errorResponse(502, "The device registry is unavailable.", config);
    const rows = (await response.json()) as DeviceRow[];
    return json({ devices: rows.map(fromDeviceRow) }, 200, {}, config);
  }

  async function handleDeviceBind(request: Request, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    const typeError = checkJsonContentType(request);
    if (typeError) return typeError;

    const body = (await readJson(request)) as Record<string, unknown>;
    const deviceId = sanitizeText(body.deviceId, 128);
    const deviceName = sanitizeText(body.deviceName, 120);
    const pairCode = normalizePairCode(sanitizeText(body.pairCode, 8));
    const position = body.position === "front" ? "front" : "rear";
    const origin = sanitizeText(body.origin, 20);
    if (!deviceId || !pairCode || pairCode.length !== 6) return errorResponse(400, "A device id and a six-character pair code are required.", config);
    if (!["signup", "pair-code", "email", "console", "url"].includes(origin)) return errorResponse(400, "Unknown assignment origin.", config);

    const record = await freshSession(resolved.record);
    const binding: TerminalBinding = {
      id: `term:${deviceId}:${position}`,
      deviceId,
      deviceName: deviceName || "Terminal",
      pairCode,
      position,
      accountId: record.userId,
      accountEmail: record.email,
      origin: origin as TerminalBinding["origin"],
      assignedAt: clock(),
      lastSeen: clock(),
    };

    const row = {
      id: binding.id,
      name: binding.deviceName,
      pair_code: binding.pairCode,
      position,
      last_seen: new Date(clock()).toISOString(),
      owner: record.userId,
      device_key: deviceId,
      account_email: record.email,
      assigned_at: new Date(binding.assignedAt).toISOString(),
      origin,
    };

    const response = await upstream.rest(
      "devices?on_conflict=id&select=*",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify([row]),
      },
      record.accessToken,
    );
    if (!response.ok) {
      logger.warn("bff: device bind rejected", { status: response.status });
      return errorResponse(409, "That terminal could not be registered.", config);
    }
    return json({ binding }, 200, {}, config);
  }

  async function handleDeviceTouch(request: Request, id: string, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    if (!DEVICE_ID.test(id)) return errorResponse(400, "Malformed device id.", config);
    const record = await freshSession(resolved.record);
    await upstream
      .rest(
        `devices?id=eq.${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ last_seen: new Date(clock()).toISOString() }),
        },
        record.accessToken,
      )
      .catch(() => undefined);
    return json({ ok: true }, 200, {}, config);
  }

  async function handleDeviceDelete(request: Request, id: string, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    if (!DEVICE_ID.test(id)) return errorResponse(400, "Malformed device id.", config);
    const record = await freshSession(resolved.record);
    await upstream.rest(`devices?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" }, record.accessToken).catch(() => undefined);
    return json({ ok: true }, 200, {}, config);
  }

  /* --------------------------------------------------- assets ------ */

  function safeAssetPath(campaignId: string, filename: string): string {
    if (!CAMPAIGN_ID.test(campaignId)) throw new HttpError(400, "Malformed campaign id.");
    // `imageObjectPath` sanitises the filename; this check only rejects the
    // inputs it cannot make safe (empty names, path traversal attempts).
    const cleanName = filename.replace(/[^A-Za-z0-9._-]/g, "");
    if (!cleanName || cleanName.startsWith(".") || cleanName.includes("..")) {
      throw new HttpError(400, "Malformed asset filename.");
    }
    return imageObjectPath({ campaignId, filename: cleanName });
  }

  async function handleAssetUpload(request: Request, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    const typeError = checkJsonContentType(request);
    if (typeError) return typeError;

    const body = (await readJson(request, config.maxBodyBytes)) as Record<string, unknown>;
    const campaignId = sanitizeText(body.campaignId, 128);
    const filename = sanitizeText(body.filename, 200);
    const contentType = sanitizeText(body.contentType, 80).toLowerCase();
    const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
    if (!ASSET_TYPES.has(contentType)) return errorResponse(415, "That asset type is not allowed.", config);
    const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
    if (!match) return errorResponse(400, "Expected a base64 data URL.", config);
    if (match[1].toLowerCase() !== contentType) return errorResponse(400, "Content type does not match the data URL.", config);

    const bytes = Buffer.from(match[2], "base64");
    if (bytes.byteLength === 0) return errorResponse(400, "The asset is empty.", config);
    if (bytes.byteLength > config.maxBodyBytes) return errorResponse(413, "The asset is too large.", config);

    const record = await freshSession(resolved.record);
    const objectPath = safeAssetPath(campaignId, filename);
    const response = await upstream.storage(
      `object/campaigns/${objectPath}`,
      {
        method: "POST",
        headers: { "Content-Type": contentType, "x-upsert": "true" },
        body: bytes,
      },
      record.accessToken,
    );
    if (!response.ok) {
      logger.warn("bff: asset upload rejected", { status: response.status });
      return errorResponse(502, "The asset could not be stored.", config);
    }
    return json(
      {
        url: `${config.supabaseUrl}/storage/v1/object/public/campaigns/${objectPath}`,
        path: objectPath,
        bytes: bytes.byteLength,
      },
      201,
      {},
      config,
    );
  }

  async function handleAssetSign(request: Request, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    const typeError = checkJsonContentType(request);
    if (typeError) return typeError;

    const body = (await readJson(request)) as Record<string, unknown>;
    const objectPath = sanitizeText(body.path, 400);
    const expiresIn = Math.min(Math.max(Number(body.expiresIn ?? 3600) || 3600, 60), 86_400);
    if (!objectPath || objectPath.includes("..")) return errorResponse(400, "Malformed asset path.", config);

    const record = await freshSession(resolved.record);
    const response = await upstream.storage(
      `object/sign/campaigns/${objectPath}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn }) },
      record.accessToken,
    );
    if (!response.ok) return errorResponse(502, "A signed URL could not be created.", config);
    const data = (await response.json()) as { signedURL?: string; signedUrl?: string };
    const signed = data.signedURL ?? data.signedUrl ?? "";
    return json(
      { url: signed.startsWith("http") ? signed : `${config.supabaseUrl}/storage/v1${signed}` },
      200,
      {},
      config,
    );
  }

  async function handleAssetDelete(request: Request, url: URL, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    const objectPath = sanitizeText(url.searchParams.get("path"), 400);
    if (!objectPath || objectPath.includes("..")) return errorResponse(400, "Malformed asset path.", config);
    const record = await freshSession(resolved.record);
    await upstream.storage(`object/campaigns/${objectPath}`, { method: "DELETE" }, record.accessToken).catch(() => undefined);
    return json({ ok: true }, 200, {}, config);
  }

  /* ------------------------------------------------ public data --- */

  async function handlePairCode(request: Request, codeRaw: string): Promise<Response> {
    // 6 characters is only ~31 bits, so this endpoint is the tightest limit in
    // the BFF: enumeration has to be made expensive, not merely unprofitable.
    const limited = await limit(request, "pair", { max: 20, windowSeconds: 60 });
    if (limited) return limited;

    const code = normalizePairCode(codeRaw);
    if (code.length !== 6) return json({ code, position: "rear", verified: false, account: null }, 200, {}, config);

    let position: "rear" | "front" = "rear";
    let verified = false;
    try {
      const response = await upstream.rest(
        "rpc/resolve_pair_code",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ p_code: code }),
        },
        config.anonKey,
      );
      if (response.ok) {
        const data = (await response.json()) as { found?: boolean; position?: string } | null;
        verified = Boolean(data?.found);
        position = data?.position === "front" ? "front" : "rear";
      } else if (response.status !== 404) {
        logger.warn("bff: pair code lookup failed", { status: response.status });
      }
    } catch (error) {
      logger.warn("bff: pair code lookup unavailable", { reason: String(error) });
    }

    // Deliberately no owner id, email, phone, city or timestamp: confirming a
    // code must not become a way to harvest booth details.
    return json({ code, position, verified, account: null }, 200, {}, config);
  }

  async function handleManifestIssue(request: Request, resolved: ResolvedSession): Promise<Response> {
    const limited = await limit(request, "api", config.apiLimit);
    if (limited) return limited;
    const record = await freshSession(resolved.record);

    // The signed list is built from approved campaigns read from the database,
    // never from a client-supplied array: a signature over client-chosen
    // entries would authorise exactly the tampering it is meant to detect.
    const params = new URLSearchParams({ select: "*", approval_state: "eq.approved", order: "updated_at.desc", limit: "200" });
    const rows = await restJson<CampaignRow[]>(
      `campaigns?${params.toString()}`,
      { headers: { Accept: "application/json" } },
      record.accessToken,
    );
    if (!rows) return errorResponse(502, "The campaign service is unavailable.", config);

    const manifest = await issueManifest(
      rows.map((row) => row.payload).filter(Boolean),
      { secret: config.manifestSecret, keyId: config.manifestKeyId },
    );
    return json({ manifest }, 200, {}, config);
  }

  async function handleManifestVerify(request: Request): Promise<Response> {
    const limited = await limit(request, "public", config.publicLimit);
    if (limited) return limited;
    const typeError = checkJsonContentType(request);
    if (typeError) return typeError;
    const body = (await readJson(request)) as { manifest?: PlaylistManifest };
    const verdict = await verifyManifest(body.manifest as PlaylistManifest, config.manifestSecret);
    return json(verdict, 200, {}, config);
  }

  /* -------------------------------------------------- dispatch ----- */

  function authError(error: unknown): Response {
    if (error instanceof UpstreamError) {
      logger.warn("bff: auth upstream error", { status: error.status, detail: error.message });
      const status = error.status === 429 ? 429 : error.status >= 500 ? 503 : 401;
      return errorResponse(status, error.publicMessage, config);
    }
    logger.error("bff: unexpected auth failure", { reason: String(error) });
    return errorResponse(500, "Sign-in is unavailable right now. Try again shortly.", config);
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (path === `${basePath}/healthz` || path === `${basePath}/health`) {
      return json({ ok: true, version, store: config.sessionStore }, 200, {}, config);
    }
    if (!path.startsWith(`${basePath}/`)) return errorResponse(404, "Not found.", config);
    const segments = path.slice(basePath.length + 1).split("/").filter(Boolean);

    // Everything below changes state unless it is a GET/HEAD on a read route.
    const changesState = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if (changesState) {
      const originError = checkOrigin(request);
      if (originError) return originError;
    }

    const resolved = await resolveSession(request);

    /* --- session / auth --- */
    if (segments[0] === "session" && segments.length === 1 && method === "GET") {
      return handleSession(request, resolved);
    }
    if (segments[0] === "auth" && method === "POST") {
      const action = segments[1];
      if (action === "signup") return handleSignUp(request);
      if (action === "login") return handleLogin(request);
      if (action === "logout") return handleLogout(request);
      if (action === "refresh") return handleRefresh(request);
      return errorResponse(404, "Not found.", config);
    }

    /* --- public projections --- */
    if (segments[0] === "public" && segments[1] === "pair" && segments.length === 3 && method === "GET") {
      return handlePairCode(request, segments[2]);
    }

    /* --- campaigns --- */
    if (segments[0] === "campaigns") {
      if (method === "GET" && segments.length === 1) return handleCampaignList(request, url, resolved);
      if (method === "GET" && segments.length === 2) return handleCampaignGet(request, segments[1], resolved);
      if (method === "PUT" && segments.length === 2) {
        if (!resolved) return errorResponse(401, "Sign in first.", config);
        const csrfError = checkCsrf(request, resolved.tokenHash);
        if (csrfError) return csrfError;
        return handleCampaignUpsert(request, segments[1], resolved);
      }
      if (method === "DELETE" && segments.length === 2) {
        if (!resolved) return errorResponse(401, "Sign in first.", config);
        const csrfError = checkCsrf(request, resolved.tokenHash);
        if (csrfError) return csrfError;
        return handleCampaignDelete(request, segments[1], resolved);
      }
      if (method === "POST" && segments.length === 3 && segments[2] === "approval") {
        if (!resolved) return errorResponse(401, "Sign in first.", config);
        const csrfError = checkCsrf(request, resolved.tokenHash);
        if (csrfError) return csrfError;
        return handleApproval(request, segments[1], resolved);
      }
      return errorResponse(405, "Method not allowed.", config);
    }

    /* --- events --- */
    if (segments[0] === "events") {
      if (method === "POST" && segments.length === 1) {
        if (resolved) {
          const csrfError = checkCsrf(request, resolved.tokenHash);
          if (csrfError) return csrfError;
        }
        return handleEventsSend(request, resolved);
      }
      if (method === "GET" && segments.length === 1) {
        if (!resolved) return errorResponse(401, "Sign in first.", config);
        return handleEventsList(request, url, resolved);
      }
      return errorResponse(405, "Method not allowed.", config);
    }

    /* --- devices --- */
    if (segments[0] === "devices") {
      if (!resolved) return errorResponse(401, "Sign in first.", config);
      if (method === "GET" && segments.length === 1) return handleDeviceList(request, url, resolved);
      if (method === "PUT" && segments.length === 1) {
        const csrfError = checkCsrf(request, resolved.tokenHash);
        if (csrfError) return csrfError;
        return handleDeviceBind(request, resolved);
      }
      if (method === "POST" && segments.length === 3 && segments[2] === "touch") {
        const csrfError = checkCsrf(request, resolved.tokenHash);
        if (csrfError) return csrfError;
        return handleDeviceTouch(request, segments[1], resolved);
      }
      if (method === "DELETE" && segments.length === 2) {
        const csrfError = checkCsrf(request, resolved.tokenHash);
        if (csrfError) return csrfError;
        return handleDeviceDelete(request, segments[1], resolved);
      }
      return errorResponse(405, "Method not allowed.", config);
    }

    /* --- assets --- */
    if (segments[0] === "assets") {
      if (!resolved) return errorResponse(401, "Sign in first.", config);
      const csrfError = method === "GET" ? null : checkCsrf(request, resolved.tokenHash);
      if (csrfError) return csrfError;
      if (method === "POST" && segments.length === 1) return handleAssetUpload(request, resolved);
      if (method === "POST" && segments.length === 2 && segments[1] === "sign") return handleAssetSign(request, resolved);
      if (method === "DELETE" && segments.length === 1) return handleAssetDelete(request, url, resolved);
      return errorResponse(405, "Method not allowed.", config);
    }

    /* --- manifest --- */
    if (segments[0] === "manifest" && method === "POST") {
      if (segments.length === 2 && segments[1] === "verify") return handleManifestVerify(request);
      if (segments.length === 1) {
        if (!resolved) return errorResponse(401, "Sign in first.", config);
        const csrfError = checkCsrf(request, resolved.tokenHash);
        if (csrfError) return csrfError;
        return handleManifestIssue(request, resolved);
      }
    }

    return errorResponse(404, "Not found.", config);
  }

  return async function handler(request: Request): Promise<Response> {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.message, config);
      logger.error("bff: unhandled error", { reason: String(error) });
      return errorResponse(500, "Something went wrong. Try again.", config);
    }
  };
}
