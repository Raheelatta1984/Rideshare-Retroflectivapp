import type {
  CampaignEventRecord,
  CommercialCampaign,
  PlaylistManifest,
  TerminalAccount,
  TerminalBinding,
} from "../../types";
import type {
  AccountRepository,
  AccountResult,
  AccountSignInInput,
  AccountSignUpInput,
  AssetStore,
  Backend,
  BackendInfo,
  CampaignRepository,
  EventSink,
  ManifestService,
  PairCodeResolution,
  RealtimeOptions,
  TerminalBindingInput,
  TerminalRegistry,
  Unsubscribe,
} from "./types";
import { blobToDataUrl } from "./local";

/**
 * Same-origin session backend (the BFF in `server/bff`).
 *
 * This adapter never sees a Supabase key and never holds a bearer token. It
 * sends credentials as an `HttpOnly` cookie that JavaScript cannot read, and
 * proves intent with the CSRF token the server binds to that session. The
 * practical consequences:
 *
 *   * a reload keeps you signed in (the cookie outlives the page), and
 *   * injected script cannot exfiltrate the session — there is nothing in the
 *     page to exfiltrate.
 *
 * It does not make the app immune to XSS: script running on the origin can
 * still act *as* the signed-in user while the page is open. That is why the
 * CSP and the "no HTML sinks" rule still matter.
 *
 * Config: `VITE_BFF_BASE` (default `/bff`). Same-origin is required, so the
 * BFF must serve the SPA or reverse-proxy `/bff` from it.
 */

export interface BffClientConfig {
  base: string;
}

export function readBffConfig(env: Record<string, unknown> = {}): BffClientConfig | null {
  const base = typeof env.VITE_BFF_BASE === "string" ? env.VITE_BFF_BASE.trim() : "";
  const requested = env.VITE_BACKEND;
  if (!base && requested !== "bff") return null;
  const normalized = (base || "/bff").replace(/\/$/, "");
  // Same-origin only. A cross-origin BFF would need CORS plus
  // `SameSite=None`, i.e. exactly the weaker cookie model this adapter exists
  // to avoid, so an absolute URL is refused rather than half-supported.
  if (!normalized.startsWith("/") || normalized.startsWith("//")) return null;
  return { base: normalized };
}

interface SessionPayload {
  account: TerminalAccount | null;
  csrfToken: string | null;
  expiresAt: number | null;
  message?: string;
}

export class BffError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BffError";
  }
}

export function createBffBackend(config: BffClientConfig, fetchImpl: typeof fetch = (...args) => fetch(...args)): Backend {
  const base = config.base;
  let csrfToken: string | null = null;
  let account: TerminalAccount | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    listeners.forEach((fn) => fn());
  }

  function store(payload: SessionPayload): TerminalAccount | null {
    account = payload.account;
    csrfToken = payload.csrfToken;
    return account;
  }

  async function call<T>(path: string, init: RequestInit = {}, options: { csrf?: boolean } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    if (options.csrf) {
      if (!csrfToken) await refresh().catch(() => undefined);
      if (!csrfToken) throw new BffError(401, "Sign in to continue.");
      headers.set("X-CSRF-Token", csrfToken);
    }

    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers,
      credentials: "include",
      cache: "no-store",
    });

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }

    if (!response.ok) {
      const message = (body as { error?: string } | null)?.error ?? `Request failed (${response.status}).`;
      if (response.status === 401) {
        account = null;
        csrfToken = null;
      }
      throw new BffError(response.status, message);
    }
    return body as T;
  }

  /** Ask the server who we are. Safe to call at any time. */
  async function refresh(): Promise<TerminalAccount | null> {
    const payload = await call<SessionPayload>("/session");
    const next = store(payload);
    notify();
    return next;
  }

  const accounts: AccountRepository = {
    async signUp(input: AccountSignUpInput): Promise<AccountResult> {
      try {
        const payload = await call<SessionPayload>("/auth/signup", {
          method: "POST",
          body: JSON.stringify({
            email: input.email,
            password: input.password,
            name: input.name,
            phone: input.phone ?? "",
            city: input.city ?? "",
          }),
        });
        const next = store(payload);
        if (!next) return { account: null, error: payload.message ?? "Account created. Confirm your email, then log in." };
        notify();
        return { account: next, error: null };
      } catch (error) {
        return { account: null, error: messageOf(error) };
      }
    },

    async signIn(input: AccountSignInInput): Promise<AccountResult> {
      try {
        const payload = await call<SessionPayload>("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: input.email, password: input.password }),
        });
        const next = store(payload);
        if (!next) return { account: null, error: "Signed in, but the account could not be loaded." };
        notify();
        return { account: next, error: null };
      } catch (error) {
        return { account: null, error: messageOf(error) };
      }
    },

    async resolvePairCode(rawCode: string): Promise<PairCodeResolution> {
      const code = rawCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (code.length !== 6) {
        return { code, position: "rear", account: null, verified: false, error: "A pair code is six characters." };
      }
      try {
        const payload = await call<{ code: string; position: "rear" | "front"; verified: boolean }>(
          `/public/pair/${encodeURIComponent(code)}`,
        );
        // The BFF deliberately returns no owner identity: confirming a code must
        // not become a way to read another booth's details. Pairing itself rides
        // the pair-code channel, so the display still binds.
        return { code: payload.code, position: payload.position, account: null, verified: payload.verified, error: null };
      } catch (error) {
        if (error instanceof BffError && error.status === 429) {
          return { code, position: "rear", account: null, verified: false, error: "Too many code lookups. Wait a minute." };
        }
        return { code, position: "rear", account: null, verified: false, error: null };
      }
    },

    current(): TerminalAccount | null {
      return account;
    },

    async signOut(): Promise<void> {
      try {
        await call<{ ok: boolean }>("/auth/logout", { method: "POST" }, { csrf: true });
      } catch {
        // The local session is cleared either way; the cookie is expired by the
        // server whenever it can be reached.
      }
      account = null;
      csrfToken = null;
      notify();
    },
  };

  const campaigns: CampaignRepository = {
    async list(query = {}) {
      const params = new URLSearchParams();
      if (query.since) params.set("since", String(query.since));
      if (query.limit) params.set("limit", String(query.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const payload = await call<{ campaigns: CommercialCampaign[] }>(`/campaigns${suffix}`);
      return payload.campaigns ?? [];
    },
    async get(id) {
      const payload = await call<{ campaign: CommercialCampaign | null }>(`/campaigns/${encodeURIComponent(id)}`);
      return payload.campaign ?? null;
    },
    async upsert(campaign) {
      const payload = await call<{ campaign: CommercialCampaign }>(
        `/campaigns/${encodeURIComponent(campaign.id)}`,
        { method: "PUT", body: JSON.stringify(campaign) },
        { csrf: true },
      );
      notify();
      return payload.campaign;
    },
    async remove(id) {
      await call<{ ok: boolean }>(`/campaigns/${encodeURIComponent(id)}`, { method: "DELETE" }, { csrf: true });
      notify();
    },
    async setApproval(id, state, reviewer, note) {
      const payload = await call<{ campaign: CommercialCampaign | null }>(
        `/campaigns/${encodeURIComponent(id)}/approval`,
        { method: "POST", body: JSON.stringify({ state, reviewer, note }) },
        { csrf: true },
      );
      notify();
      return payload.campaign ?? null;
    },
  };

  const assets: AssetStore = {
    async put({ campaignId, filename, contentType, data }) {
      const dataUrl = typeof data === "string" ? data : await blobToDataUrl(data);
      const payload = await call<{ url: string; path: string; bytes: number }>(
        "/assets",
        { method: "POST", body: JSON.stringify({ campaignId, filename, contentType, dataUrl }) },
        { csrf: true },
      );
      return payload;
    },
    async signedUrl(path, expiresInSeconds = 3600) {
      const payload = await call<{ url: string }>(
        "/assets/sign",
        { method: "POST", body: JSON.stringify({ path, expiresIn: expiresInSeconds }) },
        { csrf: true },
      );
      return payload.url;
    },
    async remove(path) {
      await call<{ ok: boolean }>(`/assets?path=${encodeURIComponent(path)}`, { method: "DELETE" }, { csrf: true });
    },
  };

  const manifest: ManifestService = {
    // Signing happens on the server, over campaigns the server itself read from
    // the database. The browser never holds a signing key.
    async issue() {
      const payload = await call<{ manifest: PlaylistManifest }>("/manifest", { method: "POST", body: "{}" }, { csrf: true });
      return payload.manifest;
    },
    async verify(value) {
      return call<{ valid: boolean; reason?: string }>("/manifest/verify", {
        method: "POST",
        body: JSON.stringify({ manifest: value }),
      });
    },
  };

  const events: EventSink = {
    async send(batch: CampaignEventRecord[]) {
      if (batch.length === 0) return;
      await call<{ accepted: number }>(
        "/events",
        {
          method: "POST",
          body: JSON.stringify({
            events: batch.map((event) => ({
              id: event.id,
              campaignId: event.campaignId,
              deviceId: event.deviceId,
              pairCode: event.pairCode,
              kind: event.kind,
              at: event.at,
              dwellSeconds: event.dwellSeconds,
              meta: event.meta,
            })),
          }),
        },
        { csrf: Boolean(csrfToken) },
      );
    },
    async list(limit = 60) {
      const payload = await call<{ events: CampaignEventRecord[] }>(`/events?limit=${encodeURIComponent(String(limit))}`);
      return payload.events ?? [];
    },
  };

  const terminals: TerminalRegistry = {
    async bind(input: TerminalBindingInput): Promise<TerminalBinding> {
      const payload = await call<{ binding: TerminalBinding }>(
        "/devices",
        {
          method: "PUT",
          body: JSON.stringify({
            deviceId: input.deviceId,
            deviceName: input.deviceName,
            pairCode: input.pairCode,
            position: input.position,
            origin: input.origin,
          }),
        },
        { csrf: true },
      );
      return payload.binding;
    },
    async find(deviceId: string) {
      const payload = await call<{ devices: TerminalBinding[] }>("/devices");
      return (payload.devices ?? []).find((item) => item.deviceId === deviceId) ?? null;
    },
    async list(accountId?: string) {
      const suffix = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
      const payload = await call<{ devices: TerminalBinding[] }>(`/devices${suffix}`);
      return payload.devices ?? [];
    },
    async touch(id: string) {
      await call<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/touch`, { method: "POST", body: "{}" }, { csrf: true }).catch(
        () => undefined,
      );
    },
    async unbind(id: string) {
      await call<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }, { csrf: true }).catch(
        () => undefined,
      );
    },
  };

  const info: BackendInfo = {
    kind: "bff",
    label: "Session service (same-origin)",
    configured: true,
    detail: `${base} · HttpOnly cookie session · tokens never reach the page`,
  };

  return {
    info: () => info,
    campaigns,
    assets,
    manifest,
    events,
    accounts,
    terminals,
    subscribe(onChange: () => void, opts: RealtimeOptions = {}): Unsubscribe {
      listeners.add(onChange);
      const interval = setInterval(() => {
        void onChange();
      }, opts.pollMs ?? 15000);
      return () => {
        listeners.delete(onChange);
        clearInterval(interval);
      };
    },
  };
}

function messageOf(error: unknown): string {
  if (error instanceof BffError) return error.message;
  if (error instanceof Error) return error.message;
  return "Request failed.";
}
