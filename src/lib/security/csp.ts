/**
 * Content-Security-Policy for a single-file SPA.
 *
 * The production document inlines the whole application as one `<script>`
 * (`vite-plugin-singlefile`), so `script-src 'self'` alone would block the app
 * and `'unsafe-inline'` would allow exactly what CSP is here to stop. The build
 * therefore hashes the emitted script and puts `'sha256-…'` in the policy — the
 * browser then runs that one exact script and nothing injected later.
 *
 * Directives a browser ignores in a `<meta>` policy (`frame-ancestors`,
 * `report-uri`, `sandbox`) are served as a real header by `vercel.json`; see
 * `HEADER_ONLY_DIRECTIVES`.
 *
 * Every origin below was verified in the Phase 1 inventory. Adding one is a
 * security decision, not a convenience: an allowed script or connect origin can
 * exfiltrate anything the page can read.
 */

export const HEADER_ONLY_DIRECTIVES = "frame-ancestors 'none';";

/** Google Fonts stylesheet + the font files it pulls in (index.html). */
export const FONT_STYLE_ORIGINS = ["https://fonts.googleapis.com"];
export const FONT_FILE_ORIGINS = ["https://fonts.gstatic.com"];
/** Hero photography (Landing/Auth) and the pairing QR generator (lib/terminals.ts). */
export const IMAGE_ORIGINS = ["https://images.pexels.com"];

/** PeerJS' public signalling host, used when no override is configured. */
export const DEFAULT_PEER_HOST = "0.peerjs.com";
export const DEFAULT_PEER_PORT = 443;

export interface CspSources {
  /** `https://<project>.supabase.co` — REST, GoTrue and Storage all live here. */
  supabaseOrigin?: string;
  /** Signalling origins (`wss://…`) for PeerJS, verified in lib/sync.ts. */
  peerSignallingOrigins?: string[];
  /** Self-hosted relay origin (`VITE_RELAY_SERVER`). */
  relayOrigin?: string;
  /** `sha256-…` hashes of the inline scripts in the built document. */
  scriptHashes?: string[];
  /** Append `upgrade-insecure-requests` (production only — never during http preview). */
  upgradeInsecureRequests?: boolean;
}

function unique(values: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(values.map((value) => (value ?? "").trim()).filter(Boolean))];
}

/** Only http(s)/ws(s) origins are accepted; anything else is dropped, not quoted. */
function safeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!/^(https?|wss?):$/.test(url.protocol)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Peer signalling sources for a PeerJS host/port pair.
 *
 * `wss:` is what the app uses in production (`secure: true` when the port is
 * 443); `https:` is included because PeerJS keeps the socket path on the same
 * host and some deployments terminate TLS in front.
 */
export function peerSignallingOrigins(host = DEFAULT_PEER_HOST, port = DEFAULT_PEER_PORT): string[] {
  const cleanHost = (host || DEFAULT_PEER_HOST).trim();
  if (!cleanHost || /[\s;]/.test(cleanHost)) return [];
  const suffix = port && port !== 443 ? `:${port}` : "";
  return unique([`wss://${cleanHost}${suffix}`, `https://${cleanHost}${suffix}`]);
}

/** Map the deployment's build-time env onto CSP sources (no guessing at runtime). */
export function cspSourcesFromEnv(env: Record<string, unknown> = {}): Omit<CspSources, "scriptHashes"> {
  const read = (key: string): string | undefined => {
    const value = env[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed && !trimmed.startsWith("$") ? trimmed : undefined;
  };

  const supabase = safeOrigin(read("VITE_SUPABASE_URL"));
  const relay = safeOrigin(read("VITE_RELAY_SERVER")) ?? safeOrigin(read("VITE_PEER_HOST"));
  const host = read("VITE_PEER_HOST") ?? DEFAULT_PEER_HOST;
  const port = Number(read("VITE_PEER_PORT") ?? DEFAULT_PEER_PORT) || DEFAULT_PEER_PORT;

  return {
    supabaseOrigin: supabase,
    relayOrigin: relay,
    peerSignallingOrigins: peerSignallingOrigins(host, port),
  };
}

/** Build the policy string. Deterministic output keeps the smoke test meaningful. */
export function buildCsp(sources: CspSources = {}): string {
  const hashes = unique(sources.scriptHashes ?? []);
  const supabase = safeOrigin(sources.supabaseOrigin);
  const relay = safeOrigin(sources.relayOrigin);
  // Default to the public signalling host the app actually dials
  // (lib/sync.ts). Every entry still has to be a ws(s)/http(s) origin: a value
  // from a config file must never become a free-text directive.
  const peer = unique(
    (sources.peerSignallingOrigins ?? peerSignallingOrigins()).map((origin) => safeOrigin(origin) ?? ""),
  );

  // `unsafe-inline` appears only in style-src: the build injects a <style> block
  // and React writes ~24 inline style attributes that cannot be hashed. Scripts
  // are hash-pinned instead — 'unsafe-inline' in script-src is never emitted.
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...hashes]],
    ["style-src", ["'self'", "'unsafe-inline'", ...FONT_STYLE_ORIGINS]],
    ["img-src", ["'self'", "data:", "blob:", ...IMAGE_ORIGINS, ...(supabase ? [supabase] : [])]],
    ["media-src", ["'self'", "data:", "blob:", ...(supabase ? [supabase] : [])]],
    ["font-src", ["'self'", "data:", ...FONT_FILE_ORIGINS]],
    ["connect-src", ["'self'", ...(supabase ? [supabase] : []), ...peer, ...(relay ? [relay] : [])]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
  ];

  const policy = directives.map(([name, values]) => `${name} ${values.join(" ")};`).join(" ");
  return sources.upgradeInsecureRequests ? `${policy} upgrade-insecure-requests;` : policy;
}

/** The `<meta http-equiv>` form of a policy (what a static host can actually serve). */
export function cspMetaTag(policy: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}" />`;
}

export const CSP_DIRECTIVE_NAMES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "media-src",
  "font-src",
  "connect-src",
  "manifest-src",
  "object-src",
  "base-uri",
  "form-action",
] as const;
