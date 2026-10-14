import type {
  CampaignApprovalState,
  CampaignEventRecord,
  CommercialCampaign,
  PlaylistManifest,
  TerminalAccount,
  TerminalBinding,
  TerminalOrigin,
  TerminalPosition,
} from "../../types";

/**
 * Phase 2 backend contract.
 *
 * Every commercial-signage backend operation goes through these interfaces so
 * the app is provider-agnostic:
 *
 *   - `local.ts`    works offline today (device storage); used by the demo,
 *                   the tests and any deployment without a backend.
 *   - `supabase.ts` talks to Supabase Postgres + Storage + Realtime over REST.
 *
 * `index.ts` picks one at runtime. Nothing in the UI imports a provider
 * directly, so swapping providers never touches component code.
 */

export type BackendKind = "local" | "supabase";

export interface BackendInfo {
  kind: BackendKind;
  label: string;
  /** False when the app is falling back because config is missing/incomplete. */
  configured: boolean;
  detail?: string;
}

/* ------------------------------------------------------------------ *
 * Campaigns
 * ------------------------------------------------------------------ */

export interface CampaignQuery {
  /** Only campaigns changed since this timestamp (used for cheap polling). */
  since?: number;
  limit?: number;
}

export interface CampaignRepository {
  list(query?: CampaignQuery): Promise<CommercialCampaign[]>;
  get(id: string): Promise<CommercialCampaign | null>;
  upsert(campaign: CommercialCampaign): Promise<CommercialCampaign>;
  remove(id: string): Promise<void>;
  /** Review action for the admin approval workflow. */
  setApproval(
    id: string,
    state: CampaignApprovalState,
    reviewer: string,
    note?: string,
  ): Promise<CommercialCampaign | null>;
}

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

export interface AssetStore {
  /**
   * Store an asset and return a URL the display can render.
   * Local: a data URL. Supabase: a public (or signed) storage URL.
   */
  put(input: { campaignId: string; filename: string; contentType: string; data: Blob | string }): Promise<{ url: string; path?: string; bytes: number }>;
  /** Signed/short-lived URL for an already-stored asset. */
  signedUrl(path: string, expiresInSeconds?: number): Promise<string>;
  remove(path: string): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Playlist manifest
 * ------------------------------------------------------------------ */

export interface ManifestService {
  /** Build (and, when configured, sign) the playlist manifest. */
  issue(campaigns: CommercialCampaign[]): Promise<PlaylistManifest>;
  /** Verify signature + integrity before the display trusts it. */
  verify(manifest: PlaylistManifest): Promise<{ valid: boolean; reason?: string }>;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface EventSink {
  /** Send a batch of events. Must reject on failure so the queue can retry. */
  send(events: CampaignEventRecord[]): Promise<void>;
  /** Recent events, newest first, for the proof-of-play view. */
  list(limit?: number): Promise<CampaignEventRecord[]>;
}

/* ------------------------------------------------------------------ *
 * Realtime
 * ------------------------------------------------------------------ */

export interface Unsubscribe {
  (): void;
}

export interface RealtimeOptions {
  /** Poll interval in ms for providers without a websocket transport. */
  pollMs?: number;
}

/* ------------------------------------------------------------------ *
 * Accounts — terminal sign-up / login
 * ------------------------------------------------------------------ */

export interface AccountSignInInput {
  email: string;
  password: string;
}

export interface AccountSignUpInput extends AccountSignInInput {
  name: string;
  phone?: string;
  city?: string;
}

export interface AccountResult {
  account: TerminalAccount | null;
  /** Human-readable failure reason, safe to render verbatim. */
  error: string | null;
}

export interface PairCodeResolution {
  /** Normalised six-character code. */
  code: string;
  position: TerminalPosition;
  /** The booth that owns the code, when the provider can see one. */
  account: TerminalAccount | null;
  /**
   * True only when a shared backend confirmed the code belongs to an account.
   *
   * The local adapter cannot confirm a code it has never seen, but the code is
   * still usable: pairing rides the pair-code channel (PeerJS/BroadcastChannel),
   * not the account record. The UI uses this flag to say so honestly instead of
   * pretending a lookup happened.
   */
  verified: boolean;
  error: string | null;
}

export interface AccountRepository {
  /** Create an account and mint its pair codes. */
  signUp(input: AccountSignUpInput): Promise<AccountResult>;
  /** Email + password sign-in. */
  signIn(input: AccountSignInInput): Promise<AccountResult>;
  /**
   * Resolve a pair code to the booth that owns it.
   * This is the "I already have a code" login path for terminals.
   */
  resolvePairCode(code: string): Promise<PairCodeResolution>;
  /** The signed-in account on this device, or null. */
  current(): TerminalAccount | null;
  signOut(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Terminals — the assign step
 * ------------------------------------------------------------------ */

export interface TerminalBindingInput {
  deviceId: string;
  deviceName: string;
  pairCode: string;
  position: TerminalPosition;
  accountId?: string | null;
  accountEmail?: string;
  origin: TerminalOrigin;
}

export interface TerminalRegistry {
  /** Create or replace the binding for this device + position. */
  bind(input: TerminalBindingInput): Promise<TerminalBinding>;
  /** The binding this device already has, if any (skips re-assignment). */
  find(deviceId: string): Promise<TerminalBinding | null>;
  /** Bindings for one account, or every binding this provider can see. */
  list(accountId?: string): Promise<TerminalBinding[]>;
  /** Heartbeat so the phone console can show a terminal as live. */
  touch(id: string): Promise<void>;
  unbind(id: string): Promise<void>;
}

export interface Backend {
  info(): BackendInfo;
  campaigns: CampaignRepository;
  assets: AssetStore;
  manifest: ManifestService;
  events: EventSink;
  /** Terminal sign-up / login. Local: the booth records in this browser. */
  accounts: AccountRepository;
  /** Terminal → booth assignment registry. */
  terminals: TerminalRegistry;
  /**
   * Subscribe to campaign/approval changes. Returns an unsubscribe function.
   * Supabase: Realtime broadcast/postgres_changes. Local: in-process events
   * plus an optional cross-tab channel.
   */
  subscribe(onChange: () => void, options?: RealtimeOptions): Unsubscribe;
}

/** Provider-agnostic re-export so adapters import everything from one place. */
export type { CampaignEventRecord };
