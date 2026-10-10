import type { CampaignEventRecord, CommercialCampaign, PlaylistManifest, TerminalAccount, TerminalBinding } from "../../types";
import type {
  AccountRepository,
  AccountResult,
  AccountSignInInput,
  AccountSignUpInput,
  AssetStore,
  Backend,
  BackendInfo,
  CampaignQuery,
  CampaignRepository,
  EventSink,
  ManifestService,
  PairCodeResolution,
  RealtimeOptions,
  TerminalBindingInput,
  TerminalRegistry,
  Unsubscribe,
} from "./types";
import { issueManifest, verifyManifest } from "./manifest";
import { blobToDataUrl, createLocalBackend } from "./local";
import { normalizePairCode, pairCode as mintPairCode } from "../id";
import { normalizeTerminalBinding, writeLocalBinding } from "../terminals";

/**
 * Supabase backend — Postgres + Storage + Realtime, over REST.
 *
 * Deliberately dependency-free (plain `fetch`) so the single-file bundle stays
 * small and the app keeps working when this adapter is unused. The schema,
 * RLS policies and storage bucket it expects are in
 * `supabase/migrations/0001_signage_phase2.sql`.
 *
 * Config (Vite only exposes VITE_*):
 *   VITE_SUPABASE_URL       https://<project>.supabase.co
 *   VITE_SUPABASE_ANON_KEY  the anon/public key
 *   VITE_SUPABASE_BUCKET    storage bucket for campaign assets (default: campaigns)
 *   VITE_SUPABASE_MANIFEST_KEY  verification secret (verify-only in the browser)
 */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  bucket: string;
  manifestKey?: string;
  manifestKeyId?: string;
}

export function isViteEnv(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.startsWith("$");
}

export function readSupabaseConfig(env: Record<string, unknown> = {}): SupabaseConfig | null {
  const url = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;
  if (!isViteEnv(url) || !isViteEnv(anonKey)) return null;
  return {
    url: String(url).replace(/\/$/, ""),
    anonKey: String(anonKey),
    bucket: isViteEnv(env.VITE_SUPABASE_BUCKET) ? String(env.VITE_SUPABASE_BUCKET) : "campaigns",
    manifestKey: isViteEnv(env.VITE_SUPABASE_MANIFEST_KEY) ? String(env.VITE_SUPABASE_MANIFEST_KEY) : undefined,
    manifestKeyId: isViteEnv(env.VITE_SUPABASE_MANIFEST_KEY_ID) ? String(env.VITE_SUPABASE_MANIFEST_KEY_ID) : undefined,
  };
}

interface CampaignRow {
  id: string;
  title: string;
  payload: CommercialCampaign;
  updated_at: string;
  approval_state: string | null;
  compliance_mode?: string | null;
}

export function createSupabaseBackend(config: SupabaseConfig, fetchImpl: typeof fetch = fetch): Backend {
  const headers: Record<string, string> = {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
    "Content-Type": "application/json",
  };

  const rest = (path: string) => `${config.url}/rest/v1/${path}`;

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetchImpl(rest(path), { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Supabase ${response.status}: ${body.slice(0, 200)}`);
    }
    return response;
  }

  async function selectCampaigns(query: CampaignQuery = {}): Promise<CommercialCampaign[]> {
    const params = new URLSearchParams({ select: "*", order: "updated_at.desc" });
    if (query.since) params.set("updated_at", `gt.${new Date(query.since).toISOString()}`);
    if (query.limit) params.set("limit", String(query.limit));
    const response = await request(`campaigns?${params.toString()}`);
    const rows = (await response.json()) as CampaignRow[];
    return rows.map((row) => row.payload).filter(Boolean);
  }

  const campaigns: CampaignRepository = {
    list: selectCampaigns,
    async get(id) {
      const response = await request(`campaigns?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
      const rows = (await response.json()) as CampaignRow[];
      return rows[0]?.payload ?? null;
    },
    async upsert(campaign) {
      const payload = { ...campaign, updatedAt: Date.now() };
      await request("campaigns?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify([
          {
            id: campaign.id,
            title: campaign.title,
            approval_state: campaign.approval?.state ?? (campaign.approved ? "approved" : "draft"),
            // Only sent for unregulated content: a project that has run 0001 but
            // not 0002 keeps working, because the column is omitted entirely.
            ...(campaign.complianceMode === "unregulated" ? { compliance_mode: "unregulated" } : {}),
            payload,
            updated_at: new Date(payload.updatedAt).toISOString(),
          },
        ]),
      });
      return payload;
    },
    async remove(id) {
      await request(`campaigns?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async setApproval(id, state, reviewer, note) {
      const existing = await campaigns.get(id);
      if (!existing) return null;
      const review = { state, reviewer, note, reviewedAt: Date.now() };
      const next: CommercialCampaign = {
        ...existing,
        approved: state === "approved",
        approval: review,
        updatedAt: review.reviewedAt,
      };
      await campaigns.upsert(next);
      await request("approval_audit", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify([
          { campaign_id: id, state, reviewer, note: note ?? null, reviewed_at: new Date(review.reviewedAt).toISOString() },
        ]),
      }).catch(() => undefined); // audit is best-effort; the decision itself already persisted
      return next;
    },
  };

  const assets: AssetStore = {
    async put({ campaignId, filename, contentType, data }) {
      const path = `${campaignId}/${filename}`;
      const body = typeof data === "string" ? dataUrlToBlob(data) : data;
      const response = await fetchImpl(`${config.url}/storage/v1/object/${config.bucket}/${path}`, {
        method: "POST",
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          "Content-Type": contentType,
          "x-upsert": "true",
        },
        body,
      });
      if (!response.ok) throw new Error(`Supabase storage ${response.status}`);
      return { url: `${config.url}/storage/v1/object/public/${config.bucket}/${path}`, path, bytes: body.size ?? 0 };
    },
    async signedUrl(path, expiresInSeconds = 3600) {
      const response = await fetchImpl(`${config.url}/storage/v1/object/sign/${config.bucket}/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!response.ok) throw new Error(`Supabase sign ${response.status}`);
      const data = (await response.json()) as { signedURL?: string; signedUrl?: string };
      const signed = data.signedURL ?? data.signedUrl ?? "";
      return signed.startsWith("http") ? signed : `${config.url}/storage/v1${signed}`;
    },
    async remove(path) {
      await fetchImpl(`${config.url}/storage/v1/object/${config.bucket}/${path}`, {
        method: "DELETE",
        headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
      });
    },
  };

  const manifest: ManifestService = {
    // Browser verifies; it never signs. The issuing secret lives in the Edge
    // Function (supabase/functions/manifest) when one is deployed.
    issue: (list) => issueManifest(list, { keyId: config.manifestKeyId }),
    verify: (value: PlaylistManifest) => verifyManifest(value, config.manifestKey),
  };

  const events: EventSink = {
    async send(batch) {
      if (batch.length === 0) return;
      await request("campaign_events", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(
          batch.map((event) => ({
            id: event.id,
            campaign_id: event.campaignId,
            device_id: event.deviceId,
            pair_code: event.pairCode ?? null,
            kind: event.kind,
            at: new Date(event.at).toISOString(),
            dwell_seconds: event.dwellSeconds ?? null,
            meta: event.meta ?? {},
          })),
        ),
      });
    },
    async list(limit = 60) {
      const response = await request(`campaign_events?select=*&order=at.desc&limit=${limit}`);
      const rows = (await response.json()) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id),
        campaignId: String(row.campaign_id),
        deviceId: String(row.device_id),
        pairCode: row.pair_code ? String(row.pair_code) : undefined,
        kind: String(row.kind) as CampaignEventRecord["kind"],
        at: new Date(String(row.at)).getTime(),
        dwellSeconds: row.dwell_seconds === null || row.dwell_seconds === undefined ? undefined : Number(row.dwell_seconds),
        meta: (row.meta ?? {}) as Record<string, unknown>,
      }));
    },
  };

  /* ------------------------------------------------------------------ *
   * Accounts — Supabase Auth over REST + a `booths` row holding the codes
   *
   * Schema: supabase/migrations/0003_terminal_signup.sql
   *   booths           one row per account: owner uuid, name, pair codes
   *   booth_directory  anon-readable view (no email/phone) used to confirm a
   *                    scanned pair code without exposing who owns it
   *   devices          the terminal registry, extended with device_key/origin
   *
   * A terminal that binds to a code with no session on the device falls back to
   * the local adapter, so the flow never dead-ends when auth is unavailable.
   * ------------------------------------------------------------------ */

  const SESSION_KEY = "rf:backend:supabase-session";
  const localFallback = createLocalBackend({ secret: config.manifestKey, keyId: config.manifestKeyId });

  interface StoredSession {
    accessToken: string;
    refreshToken?: string;
    account: TerminalAccount;
  }

  interface AuthSession {
    access_token?: string;
    refresh_token?: string;
    user?: { id: string; email?: string; user_metadata?: Record<string, unknown> };
    /** GoTrue returns an empty identities array when the email is taken. */
    identities?: unknown[];
  }

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

  function readStoredSession(): StoredSession | null {
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredSession;
      return parsed?.accessToken && parsed?.account ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeStoredSession(session: StoredSession | null): void {
    if (typeof localStorage === "undefined") return;
    try {
      if (!session) localStorage.removeItem(SESSION_KEY);
      else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // A full localStorage must not break sign-in for this render.
    }
  }

  async function authRequest<T>(path: string, body: unknown, token?: string): Promise<T> {
    const response = await fetchImpl(`${config.url}/auth/v1/${path}`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${token ?? config.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 200);
      try {
        message = (JSON.parse(text) as { msg?: string; message?: string; error_description?: string }).msg
          ?? (JSON.parse(text) as { message?: string }).message
          ?? (JSON.parse(text) as { error_description?: string }).error_description
          ?? message;
      } catch {
        /* keep the raw body */
      }
      throw new Error(message || `Supabase auth ${response.status}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function loadBooth(ownerId: string, token: string): Promise<BoothRow | null> {
    const response = await fetchImpl(
      rest(`booths?owner=eq.${encodeURIComponent(ownerId)}&select=*&limit=1`),
      { headers: { ...headers, Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return null;
    const rows = (await response.json()) as BoothRow[];
    return rows[0] ?? null;
  }

  /** The booth for a session, minting one (with fresh pair codes) on first use. */
  async function ensureBooth(session: AuthSession, token: string): Promise<BoothRow | null> {
    const ownerId = session.user?.id ?? "";
    if (!ownerId) return null;
    const existing = await loadBooth(ownerId, token);
    if (existing) return existing;

    const metadata = session.user?.user_metadata ?? {};
    const attempt = async (codes: { pair: string; front: string }) => {
      const response = await fetchImpl(rest("booths"), {
        method: "POST",
        headers: { Prefer: "return=representation", ...headers, Authorization: `Bearer ${token}` },
        body: JSON.stringify([
          {
            owner: ownerId,
            name: String(metadata.name ?? session.user?.email ?? "Driver"),
            email: session.user?.email ?? null,
            phone: metadata.phone ? String(metadata.phone) : null,
            city: metadata.city ? String(metadata.city) : null,
            pair_code: codes.pair,
            front_pair_code: codes.front,
          },
        ]),
      });
      return response.ok ? (((await response.json()) as BoothRow[])[0] ?? null) : null;
    };

    // pair_code carries a unique index; a collision just means "try another".
    return (
      (await attempt({ pair: mintPairCode(), front: mintPairCode() }))
      ?? (await attempt({ pair: mintPairCode(), front: mintPairCode() }))
      ?? loadBooth(ownerId, token)
    );
  }

  async function adoptSession(session: AuthSession): Promise<TerminalAccount | null> {
    const token = session.access_token ?? "";
    if (!token) return null;
    const booth = await ensureBooth(session, token).catch(() => null);
    const metadata = session.user?.user_metadata ?? {};
    const account: TerminalAccount = {
      id: booth?.owner ?? session.user?.id ?? "",
      name: booth?.name ?? String(metadata.name ?? session.user?.email ?? "Driver"),
      email: session.user?.email ?? "",
      phone: booth?.phone ?? (metadata.phone ? String(metadata.phone) : ""),
      city: booth?.city ?? (metadata.city ? String(metadata.city) : ""),
      pairCode: booth?.pair_code ?? "",
      frontPairCode: booth?.front_pair_code ?? undefined,
      createdAt: booth?.created_at ?? new Date().toISOString(),
      source: "supabase",
    };
    writeStoredSession({ accessToken: token, refreshToken: session.refresh_token, account });
    return account;
  }

  const accounts: AccountRepository = {
    async signUp(input: AccountSignUpInput): Promise<AccountResult> {
      try {
        const session = await authRequest<AuthSession>("signup", {
          email: input.email.trim().toLowerCase(),
          password: input.password,
          data: { name: input.name.trim(), phone: input.phone ?? "", city: input.city ?? "" },
        });
        if (Array.isArray(session.identities) && session.identities.length === 0) {
          return { account: null, error: "An account already exists for that email. Log in instead." };
        }
        if (!session.access_token) {
          return {
            account: null,
            error: "Account created. Open the confirmation email, then log in on this terminal.",
          };
        }
        const account = await adoptSession(session);
        return account ? { account, error: null } : { account: null, error: "Signed in, but no booth could be created. Ask an administrator to check the booths table." };
      } catch (error) {
        return { account: null, error: error instanceof Error ? error.message : "Sign-up failed." };
      }
    },

    async signIn(input: AccountSignInInput): Promise<AccountResult> {
      try {
        const session = await authRequest<AuthSession>("token?grant_type=password", {
          email: input.email.trim().toLowerCase(),
          password: input.password,
        });
        if (!session.access_token) return { account: null, error: "Email or password is wrong." };
        const account = await adoptSession(session);
        return account ? { account, error: null } : { account: null, error: "Signed in, but no booth could be loaded." };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Login failed.";
        return { account: null, error: /invalid login credentials/i.test(message) ? "Email or password is wrong." : message };
      }
    },

    async resolvePairCode(rawCode: string): Promise<PairCodeResolution> {
      const code = normalizePairCode(rawCode);
      if (code.length !== 6) {
        return { code, position: "rear", account: null, verified: false, error: "A pair code is six characters." };
      }
      try {
        // The directory view is anon-readable and deliberately excludes email and
        // phone: confirming a code must not become a way to harvest contacts.
        const response = await fetchImpl(
          rest(`booth_directory?select=*&or=(pair_code.eq.${code},front_pair_code.eq.${code})&limit=1`),
          { headers },
        );
        if (!response.ok) throw new Error(`directory ${response.status}`);
        const rows = (await response.json()) as BoothRow[];
        const booth = rows[0];
        if (!booth) return { code, position: "rear", account: null, verified: false, error: null };
        return {
          code,
          position: normalizePairCode(booth.front_pair_code) === code ? "front" : "rear",
          account: {
            id: booth.owner ?? booth.id,
            name: booth.name ?? "Retroflex booth",
            email: "",
            phone: "",
            city: booth.city ?? "",
            pairCode: booth.pair_code,
            frontPairCode: booth.front_pair_code ?? undefined,
            createdAt: booth.created_at ?? new Date().toISOString(),
            source: "supabase",
          },
          verified: true,
          error: null,
        };
      } catch {
        // Migration 0003 not applied, or offline: fall back to whatever this
        // device already knows, and let the code pair over the sync channel.
        return localFallback.accounts.resolvePairCode(code);
      }
    },

    current(): TerminalAccount | null {
      return readStoredSession()?.account ?? null;
    },

    async signOut(): Promise<void> {
      const session = readStoredSession();
      if (session?.refreshToken) {
        await authRequest("logout", { refresh_token: session.refreshToken }, session.accessToken).catch(() => undefined);
      }
      writeStoredSession(null);
    },
  };

  function toDeviceRow(binding: TerminalBinding, ownerId: string | null, withExtras: boolean): Record<string, unknown> {
    return {
      id: binding.id,
      name: binding.deviceName,
      pair_code: binding.pairCode,
      position: binding.position,
      last_seen: new Date().toISOString(),
      owner: ownerId,
      // 0003 columns. Omitted entirely when the project predates that
      // migration, because PostgREST rejects unknown columns with a 400.
      ...(withExtras
        ? {
            device_key: binding.deviceId,
            account_email: binding.accountEmail ?? null,
            assigned_at: new Date(binding.assignedAt).toISOString(),
            origin: binding.origin,
          }
        : {}),
    };
  }

  function fromDeviceRow(row: DeviceRow): TerminalBinding | null {
    return normalizeTerminalBinding({
      id: row.id,
      deviceId: row.device_key ?? row.id,
      deviceName: row.name,
      pairCode: row.pair_code,
      position: row.position === "front" ? "front" : "rear",
      accountId: row.owner ?? null,
      accountEmail: row.account_email ?? undefined,
      origin: (row.origin ?? "console") as TerminalBinding["origin"],
      assignedAt: row.assigned_at ? new Date(row.assigned_at).getTime() : Date.parse(row.last_seen ?? "") || Date.now(),
      lastSeen: row.last_seen ? Date.parse(row.last_seen) : undefined,
    });
  }

  const terminals: TerminalRegistry = {
    async bind(input: TerminalBindingInput): Promise<TerminalBinding> {
      const session = readStoredSession();
      // Anonymous terminal (code login with no account on this device): keep the
      // assignment local. The display still works — pairing is code-based.
      if (!session) return localFallback.terminals.bind(input);

      const binding: TerminalBinding = {
        id: input.deviceId ? `term:${input.deviceId}:${input.position === "front" ? "front" : "rear"}` : `term:${Date.now()}`,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        pairCode: normalizePairCode(input.pairCode),
        position: input.position === "front" ? "front" : "rear",
        accountId: input.accountId ?? session.account.id,
        accountEmail: input.accountEmail ?? session.account.email,
        origin: input.origin,
        assignedAt: Date.now(),
        lastSeen: Date.now(),
      };

      const upsert = async (withExtras: boolean) => {
        const response = await fetchImpl(rest("devices?on_conflict=id"), {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates,return=representation",
            ...headers,
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify([toDeviceRow(binding, binding.accountId, withExtras)]),
        });
        return response.ok;
      };

      try {
        const ok = (await upsert(true)) || (await upsert(false));
        writeLocalBinding(binding);
        if (!ok) return localFallback.terminals.bind(input);
        return binding;
      } catch {
        return localFallback.terminals.bind(input);
      }
    },

    async find(deviceId: string): Promise<TerminalBinding | null> {
      const session = readStoredSession();
      if (!session) return localFallback.terminals.find(deviceId);
      try {
        const response = await fetchImpl(
          rest(`devices?select=*&or=(device_key.eq.${encodeURIComponent(deviceId)},id.eq.${encodeURIComponent(deviceId)})&limit=1`),
          { headers: { ...headers, Authorization: `Bearer ${session.accessToken}` } },
        );
        if (!response.ok) throw new Error(`devices ${response.status}`);
        const rows = (await response.json()) as DeviceRow[];
        return rows[0] ? fromDeviceRow(rows[0]) : localFallback.terminals.find(deviceId);
      } catch {
        return localFallback.terminals.find(deviceId);
      }
    },

    async list(accountId?: string): Promise<TerminalBinding[]> {
      const session = readStoredSession();
      if (!session) return localFallback.terminals.list(accountId);
      try {
        const filter = accountId ? `&owner=eq.${encodeURIComponent(accountId)}` : "";
        const response = await fetchImpl(
          rest(`devices?select=*&order=last_seen.desc${filter}`),
          { headers: { ...headers, Authorization: `Bearer ${session.accessToken}` } },
        );
        if (!response.ok) throw new Error(`devices ${response.status}`);
        const rows = (await response.json()) as DeviceRow[];
        return rows.map(fromDeviceRow).filter((item): item is TerminalBinding => item !== null);
      } catch {
        return localFallback.terminals.list(accountId);
      }
    },

    async touch(id: string): Promise<void> {
      const session = readStoredSession();
      if (!session) return localFallback.terminals.touch(id);
      await fetchImpl(rest(`devices?id=eq.${encodeURIComponent(id)}`), {
        method: "PATCH",
        headers: { Prefer: "return=minimal", ...headers, Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ last_seen: new Date().toISOString() }),
      }).catch(() => undefined); // heartbeat is best-effort
    },

    async unbind(id: string): Promise<void> {
      const session = readStoredSession();
      await localFallback.terminals.unbind(id);
      if (!session) return;
      await fetchImpl(rest(`devices?id=eq.${encodeURIComponent(id)}`), {
        method: "DELETE",
        headers: { Prefer: "return=minimal", ...headers, Authorization: `Bearer ${session.accessToken}` },
      }).catch(() => undefined);
    },
  };

  const info: BackendInfo = {
    kind: "supabase",
    label: "Supabase (shared)",
    configured: true,
    detail: `${config.url.replace(/^https?:\/\//, "")} · bucket "${config.bucket}"`,
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
      // Polling on updated_at: no websocket dependency in the single-file build.
      // Realtime websocket (postgres_changes) is the documented upgrade in
      // PHASE-2.md — same subscribe() contract, so the UI doesn't change.
      const interval = setInterval(() => {
        void onChange();
      }, opts.pollMs ?? 15000);
      return () => clearInterval(interval);
    },
  };
}

/** Minimal data-URL → Blob, used when the console hands us a cached asset. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, base64] = dataUrl.split(",");
  const contentType = /:(.*?);/.exec(meta ?? "")?.[1] ?? "application/octet-stream";
  if (!base64) return new Blob([dataUrl], { type: contentType });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

export async function blobToDataUrlCompat(blob: Blob): Promise<string> {
  return blobToDataUrl(blob);
}
