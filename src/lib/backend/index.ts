import type { Backend } from "./types";
import { createLocalBackend } from "./local";
import { createSupabaseBackend, readSupabaseConfig } from "./supabase";
import { createBffBackend, readBffConfig } from "./bff";

/**
 * Provider selection.
 *
 *   VITE_BFF_BASE=/bff      use the same-origin session service (server/bff)
 *   VITE_BACKEND=bff        force the same-origin session service
 *   VITE_BACKEND=supabase   force the direct Supabase adapter (token in memory)
 *   VITE_BACKEND=local      force the on-device adapter
 *   (unset)                 BFF when configured, else Supabase, else local
 *
 * The BFF is preferred whenever it exists: it is the only adapter where the
 * browser never holds a bearer token. The direct Supabase adapter is kept for
 * deployments that are still static-only (GitHub Pages cannot host a server).
 *
 * The rest of the app only ever sees `Backend`, so switching providers is a
 * config change, not a code change.
 */

export * from "./types";
export { createLocalBackend, newEventId, toTerminalAccount, uniquePairCode } from "./local";
export { createSupabaseBackend, readSupabaseConfig } from "./supabase";
export { createBffBackend, readBffConfig } from "./bff";
export { issueManifest, verifyManifest, buildManifestEntries, canonicalize } from "./manifest";
export { EventQueue } from "./queue";

let cached: Backend | null = null;

function env(): Record<string, unknown> {
  return (import.meta.env ?? {}) as Record<string, unknown>;
}

export function resolveBackend(): Backend {
  if (cached) return cached;

  const environment = env();
  const requested = environment.VITE_BACKEND;
  const bffConfig = readBffConfig(environment);
  const supabaseConfig = readSupabaseConfig(environment);

  const wantsBff = requested === "bff" || (requested !== "local" && bffConfig !== null);
  if (wantsBff && bffConfig) {
    cached = createBffBackend(bffConfig);
    return cached;
  }

  const wantsSupabase = requested === "supabase" || (requested !== "local" && supabaseConfig !== null);
  if (wantsSupabase && supabaseConfig) {
    cached = createSupabaseBackend(supabaseConfig);
    return cached;
  }

  cached = createLocalBackend({
    secret: typeof environment.VITE_SUPABASE_MANIFEST_KEY === "string"
      ? (environment.VITE_SUPABASE_MANIFEST_KEY as string)
      : undefined,
  });
  return cached;
}

export function getBackend(): Backend {
  return resolveBackend();
}

/** Test seam — forget the memoised instance. */
export function resetBackend(): void {
  cached = null;
}
