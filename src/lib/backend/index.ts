import type { Backend } from "./types";
import { createLocalBackend } from "./local";
import { createSupabaseBackend, readSupabaseConfig } from "./supabase";

/**
 * Provider selection.
 *
 *   VITE_BACKEND=supabase   force Supabase (fails closed to local if unconfigured)
 *   VITE_BACKEND=local      force the on-device adapter
 *   (unset)                 use Supabase when its env vars are present, else local
 *
 * The rest of the app only ever sees `Backend`, so switching providers is a
 * config change, not a code change.
 */

export * from "./types";
export { createLocalBackend, newEventId } from "./local";
export { createSupabaseBackend, readSupabaseConfig } from "./supabase";
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
  const config = readSupabaseConfig(environment);
  const wantsSupabase = requested === "supabase" || (requested !== "local" && config !== null);

  if (wantsSupabase && config) {
    cached = createSupabaseBackend(config);
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
