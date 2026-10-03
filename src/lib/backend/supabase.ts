import type { CampaignEventRecord, CommercialCampaign, PlaylistManifest } from "../../types";
import type {
  AssetStore,
  Backend,
  BackendInfo,
  CampaignQuery,
  CampaignRepository,
  EventSink,
  ManifestService,
  RealtimeOptions,
  Unsubscribe,
} from "./types";
import { issueManifest, verifyManifest } from "./manifest";
import { blobToDataUrl } from "./local";

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
