import { uid, pairCode as makePairCode, normalizePairCode } from "../id";
import type { CommercialCampaign, Driver, TerminalAccount, TerminalBinding } from "../../types";
import type {
  AccountRepository,
  AccountSignInInput,
  AccountSignUpInput,
  AccountResult,
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
import type { CampaignEventRecord } from "../../types";
import { issueManifest, verifyManifest } from "./manifest";
import { db, defaultSettings } from "../storage";
import {
  normalizeTerminalBinding,
  readLocalBinding,
  terminalBindingId,
  writeLocalBinding,
} from "../terminals";

/**
 * Local backend — the zero-config default.
 *
 * Stores campaigns, events and assets on the device and emits in-process change
 * notifications (plus a BroadcastChannel so two tabs stay in sync). This is what
 * runs in the demo, in tests, and in any deployment that hasn't been pointed at
 * a server yet — the same code paths the Supabase adapter implements.
 *
 * Accounts and terminals here map straight onto the booth records the driver
 * console already uses (`rf:drivers`, `rf:session`), so a terminal that signs up
 * on this browser is the same identity the console logs into. There is exactly
 * one account model, not a parallel terminal one.
 */

const CAMPAIGNS_KEY = "rf:backend:campaigns";
const EVENTS_KEY = "rf:backend:events";
const ASSETS_KEY = "rf:backend:assets";
const TERMINALS_KEY = "rf:backend:terminals";
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

  const accounts: AccountRepository = {
    async signUp(input: AccountSignUpInput): Promise<AccountResult> {
      const email = (input.email ?? "").trim().toLowerCase();
      const password = input.password ?? "";
      const name = (input.name ?? "").trim();
      if (name.length < 2) return { account: null, error: "Enter the name the booth should show." };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { account: null, error: "Enter a valid email address." };
      if (password.length < 8) return { account: null, error: "Use at least 8 characters for the password." };
      if (db.findByEmail(email)) {
        return { account: null, error: "An account already exists for that email. Log in instead." };
      }

      const driver: Driver = {
        id: uid("drv"),
        name,
        email,
        password,
        phone: (input.phone ?? "").trim(),
        city: (input.city ?? "").trim(),
        pairCode: uniquePairCode(),
        frontPairCode: uniquePairCode(),
        createdAt: new Date().toISOString(),
        platforms: ["uber", "didi"],
        vehicle: { make: "", model: "", color: "", plate: "", year: "" },
        role: "driver",
      };
      db.saveDriver(driver);
      db.saveSettings(driver.id, defaultSettings());
      db.setSession({ driverId: driver.id });
      notify();
      return { account: toTerminalAccount(driver), error: null };
    },

    async signIn(input: AccountSignInInput): Promise<AccountResult> {
      const found = db.findByEmail((input.email ?? "").trim());
      if (!found || found.password !== input.password) {
        return { account: null, error: "Email or password is wrong." };
      }
      db.setSession({ driverId: found.id });
      return { account: toTerminalAccount(found), error: null };
    },

    async resolvePairCode(rawCode: string): Promise<PairCodeResolution> {
      const code = normalizePairCode(rawCode);
      if (code.length !== 6) {
        return { code, position: "rear", account: null, verified: false, error: "A pair code is six characters." };
      }
      const owner = db.listDrivers().find(
        (driver) => driver.pairCode?.toUpperCase() === code || driver.frontPairCode?.toUpperCase() === code,
      );
      if (!owner) {
        // Not an error: pairing travels over the pair-code channel, so a code
        // issued elsewhere still drives this display. It just cannot be
        // confirmed from this browser, and the UI says so.
        return { code, position: "rear", account: null, verified: false, error: null };
      }
      return {
        code,
        position: owner.frontPairCode?.toUpperCase() === code ? "front" : "rear",
        account: toTerminalAccount(owner),
        verified: true,
        error: null,
      };
    },

    current(): TerminalAccount | null {
      const session = db.getSession();
      if (!session) return null;
      const driver = db.findById(session.driverId);
      return driver ? toTerminalAccount(driver) : null;
    },

    async signOut(): Promise<void> {
      db.setSession(null);
      notify();
    },
  };

  const terminals: TerminalRegistry = {
    async bind(input: TerminalBindingInput): Promise<TerminalBinding> {
      const position = input.position === "front" ? "front" : "rear";
      const binding: TerminalBinding = {
        id: terminalBindingId(input.deviceId, position),
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        pairCode: normalizePairCode(input.pairCode),
        position,
        accountId: input.accountId ?? null,
        accountEmail: input.accountEmail,
        origin: input.origin,
        assignedAt: Date.now(),
        lastSeen: Date.now(),
      };
      // One physical terminal holds one position: re-assigning rear → front
      // replaces the old binding instead of leaving a ghost device behind.
      const all = read<TerminalBinding[]>(TERMINALS_KEY, []).filter(
        (item) => item.deviceId !== binding.deviceId || item.position === binding.position,
      );
      write(TERMINALS_KEY, [...all.filter((item) => item.id !== binding.id), binding]);
      writeLocalBinding(binding);
      notify();
      return binding;
    },

    async find(deviceId: string): Promise<TerminalBinding | null> {
      const stored = read<TerminalBinding[]>(TERMINALS_KEY, []).filter((item) => item.deviceId === deviceId);
      if (stored.length) return normalizeTerminalBinding(stored[stored.length - 1]);
      const pointer = readLocalBinding();
      return pointer?.deviceId === deviceId ? pointer : null;
    },

    async list(accountId?: string): Promise<TerminalBinding[]> {
      const all = read<TerminalBinding[]>(TERMINALS_KEY, [])
        .map((item) => normalizeTerminalBinding(item))
        .filter((item): item is TerminalBinding => item !== null);
      const scoped = accountId ? all.filter((item) => item.accountId === accountId) : all;
      return scoped.sort((a, b) => b.assignedAt - a.assignedAt);
    },

    async touch(id: string): Promise<void> {
      const all = read<TerminalBinding[]>(TERMINALS_KEY, []);
      write(TERMINALS_KEY, all.map((item) => (item.id === id ? { ...item, lastSeen: Date.now() } : item)));
      const pointer = readLocalBinding();
      if (pointer?.id === id) writeLocalBinding({ ...pointer, lastSeen: Date.now() });
    },

    async unbind(id: string): Promise<void> {
      write(TERMINALS_KEY, read<TerminalBinding[]>(TERMINALS_KEY, []).filter((item) => item.id !== id));
      if (readLocalBinding()?.id === id) writeLocalBinding(null);
      notify();
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
    accounts,
    terminals,
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

/**
 * Project a booth record onto the account shape the terminal flow uses.
 * The password never leaves the storage layer.
 */
export function toTerminalAccount(driver: Driver): TerminalAccount {
  return {
    id: driver.id,
    name: driver.name,
    email: driver.email,
    phone: driver.phone ?? "",
    city: driver.city ?? "",
    pairCode: driver.pairCode ?? "",
    frontPairCode: driver.frontPairCode,
    role: driver.role,
    createdAt: driver.createdAt,
    source: "local",
  };
}

/** Mint a pair code no local booth is already using. */
export function uniquePairCode(): string {
  const taken = new Set(
    db.listDrivers().flatMap((driver) => [driver.pairCode, driver.frontPairCode].map(normalizePairCode).filter(Boolean)),
  );
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const code = makePairCode();
    if (!taken.has(code)) return code;
  }
  return makePairCode();
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
