import { uid } from "../id";
import type { CommercialCampaign } from "../../types";
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
import type { CampaignEventRecord } from "../../types";
import { issueManifest, verifyManifest } from "./manifest";

/**
 * Local backend — the zero-config default.
 *
 * Stores campaigns, events and assets on the device and emits in-process change
 * notifications (plus a BroadcastChannel so two tabs stay in sync). This is what
 * runs in the demo, in tests, and in any deployment that hasn't been pointed at
 * a server yet — the same code paths the Supabase adapter implements.
 */

const CAMPAIGNS_KEY = "rf:backend:campaigns";
const EVENTS_KEY = "rf:backend:events";
const ASSETS_KEY = "rf:backend:assets";
const CHANNEL = "retroflex-backend";
const MAX_EVENTS = 500;

function read<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded — dropping telemetry is better than breaking the display.
  }
}

export function createLocalBackend(options: { secret?: string; keyId?: string } = {}): Backend {
  const listeners = new Set<() => void>();
  let channel: BroadcastChannel | null = null;

  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.addEventListener("message", () => listeners.forEach((fn) => fn()));
    } catch {
      channel = null;
    }
  }

  const notify = () => {
    listeners.forEach((fn) => fn());
    try {
      channel?.postMessage({ at: Date.now() });
    } catch {
      // channel closed
    }
  };

  const listCampaigns = (query: CampaignQuery = {}) => {
    const all = read<CommercialCampaign[]>(CAMPAIGNS_KEY, []);
    const since = query.since ?? 0;
    const filtered = all
      .filter((campaign) => (campaign.updatedAt ?? campaign.createdAt ?? 0) > since)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return query.limit ? filtered.slice(0, query.limit) : filtered;
  };

  const campaigns: CampaignRepository = {
    async list(query = {}) {
      return listCampaigns(query);
    },
    async get(id) {
      return read<CommercialCampaign[]>(CAMPAIGNS_KEY, []).find((c) => c.id === id) ?? null;
    },
    async upsert(campaign) {
      const next = { ...campaign, updatedAt: Date.now() };
      const all = read<CommercialCampaign[]>(CAMPAIGNS_KEY, []);
      write(CAMPAIGNS_KEY, [...all.filter((c) => c.id !== next.id), next]);
      notify();
      return next;
    },
    async remove(id) {
      const all = read<CommercialCampaign[]>(CAMPAIGNS_KEY, []);
      write(
        CAMPAIGNS_KEY,
        all.filter((c) => c.id !== id),
      );
      notify();
    },
    async setApproval(id, state, reviewer, note) {
      const all = read<CommercialCampaign[]>(CAMPAIGNS_KEY, []);
      const found = all.find((c) => c.id === id);
      if (!found) return null;
      const next: CommercialCampaign = {
        ...found,
        approved: state === "approved",
        approval: { state, reviewer, note, reviewedAt: Date.now() },
        updatedAt: Date.now(),
      };
      write(
        CAMPAIGNS_KEY,
        all.map((c) => (c.id === id ? next : c)),
      );
      notify();
      return next;
    },
  };

  const assets: AssetStore = {
    async put({ campaignId, filename, contentType, data }) {
      const path = `${campaignId}/${filename}`;
      const url = typeof data === "string" ? data : await blobToDataUrl(data);
      const store = read<Record<string, string>>(ASSETS_KEY, {});
      store[path] = url;
      write(ASSETS_KEY, store);
      return { url, path, bytes: url.length, contentType } as { url: string; path: string; bytes: number };
    },
    async signedUrl(path) {
      const store = read<Record<string, string>>(ASSETS_KEY, {});
      const url = store[path];
      if (!url) throw new Error(`Asset not found: ${path}`);
      return url;
    },
    async remove(path) {
      const store = read<Record<string, string>>(ASSETS_KEY, {});
      delete store[path];
      write(ASSETS_KEY, store);
    },
  };

  const manifest: ManifestService = {
    issue: (campaignsToSign) =>
      issueManifest(campaignsToSign, { secret: options.secret, keyId: options.keyId }),
    verify: (value) => verifyManifest(value, options.secret),
  };

  const events: EventSink = {
    async send(batch) {
      if (batch.length === 0) return;
      const existing = read<CampaignEventRecord[]>(EVENTS_KEY, []);
      write(EVENTS_KEY, [...batch, ...existing].slice(0, MAX_EVENTS));
      notify();
    },
    async list(limit = 60) {
      // Sort by time: a batched send arrives as one array, so insertion order
      // alone is not enough to guarantee newest-first for the proof-of-play view.
      return read<CampaignEventRecord[]>(EVENTS_KEY, [])
        .slice()
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    },
  };

  const info: BackendInfo = {
    kind: "local",
    label: "On-device (local)",
    configured: true,
    detail: "Campaigns, assets and events stay on this device. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable the shared backend.",
  };

  return {
    info: () => info,
    campaigns,
    assets,
    manifest,
    events,
    subscribe(onChange: () => void, opts: RealtimeOptions = {}): Unsubscribe {
      listeners.add(onChange);
      const poll = opts.pollMs
        ? setInterval(() => {
            // Cross-tab changes arrive via BroadcastChannel; this is a safety net.
            onChange();
          }, opts.pollMs)
        : null;
      const unsubscribe = () => {
        listeners.delete(onChange);
        if (poll) clearInterval(poll);
      };
      return unsubscribe;
    },
  };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

/** Convenience used by tests and the console. */
export function newEventId(): string {
  return uid("evt");
}
