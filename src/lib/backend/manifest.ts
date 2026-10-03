import type { CommercialCampaign, ManifestEntry, PlaylistManifest } from "../../types";

/**
 * Signed playlist manifest (plan: "Signed asset URLs and a signed playlist
 * manifest").
 *
 * The manifest is the display's contract: it lists exactly which campaigns may
 * run and for how long. Signing it means a tampered local copy can be detected
 * before the glass shows something unapproved.
 *
 * Signing uses WebCrypto HMAC-SHA256 over a canonical serialisation. In
 * production the secret belongs on the server (a Supabase Edge Function, see
 * `supabase/functions/manifest/index.ts`); the browser only ever *verifies*.
 * When no secret is configured the manifest is issued unsigned and
 * `verify()` reports that, rather than pretending it is trustworthy.
 */

export const MANIFEST_ALGORITHM = "HMAC-SHA256";
export const MANIFEST_VERSION = 2;

export interface ManifestOptions {
  secret?: string;
  keyId?: string;
  now?: number;
  version?: number;
}

/**
 * Deterministic JSON: keys sorted, so the same campaign data always produces
 * the same bytes (and therefore the same signature).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

/** Only eligible campaigns with a usable asset belong in a manifest. */
export function manifestEntry(campaign: CommercialCampaign): ManifestEntry | null {
  const asset = campaign.assetUrl?.trim() || campaign.assetDataUrl;
  if (!asset || !campaign.id) return null;
  return {
    id: campaign.id,
    title: campaign.title,
    asset,
    mediaType: campaign.mediaType,
    dwellSeconds: campaign.displaySeconds,
    displaySeconds: campaign.displaySeconds,
    brightnessCap: campaign.brightnessCap,
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    geoRule: campaign.geoRule,
  };
}

export function buildManifestEntries(campaigns: CommercialCampaign[]): ManifestEntry[] {
  return campaigns
    .map(manifestEntry)
    .filter((entry): entry is ManifestEntry => entry !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto unavailable");
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign("HMAC", key, encoder.encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The exact bytes a signature covers. */
export function signingPayload(manifest: Omit<PlaylistManifest, "signature">): string {
  return canonicalize({
    version: manifest.version,
    issuedAt: manifest.issuedAt,
    entries: manifest.entries,
  });
}

export async function issueManifest(
  campaigns: CommercialCampaign[],
  options: ManifestOptions = {},
): Promise<PlaylistManifest> {
  const manifest: PlaylistManifest = {
    version: options.version ?? MANIFEST_VERSION,
    issuedAt: options.now ?? Date.now(),
    keyId: options.keyId,
    entries: buildManifestEntries(campaigns),
  };

  if (!options.secret) return manifest;

  return { ...manifest, algorithm: MANIFEST_ALGORITHM, signature: await hmacHex(options.secret, signingPayload(manifest)) };
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

export async function verifyManifest(
  manifest: PlaylistManifest,
  secret?: string,
): Promise<VerifyResult> {
  if (!manifest || !Array.isArray(manifest.entries)) {
    return { valid: false, reason: "malformed manifest" };
  }

  const { signature, ...rest } = manifest;
  if (!signature) {
    return secret
      ? { valid: false, reason: "manifest is unsigned but a signing secret is configured" }
      : { valid: true, reason: "unsigned (no signing secret configured)" };
  }

  if (!secret) return { valid: false, reason: "signature present but no secret configured" };
  if (manifest.algorithm && manifest.algorithm !== MANIFEST_ALGORITHM) {
    return { valid: false, reason: `unsupported algorithm ${manifest.algorithm}` };
  }

  let expected: string;
  try {
    expected = await hmacHex(secret, signingPayload(rest));
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : "signing failed" };
  }

  return constantTimeEqual(expected, signature)
    ? { valid: true }
    : { valid: false, reason: "signature mismatch" };
}

/** Length-independent comparison to avoid leaking how much of the MAC matched. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
