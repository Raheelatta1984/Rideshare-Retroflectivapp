/**
 * BFF configuration — server-side only.
 *
 * Nothing in this module is bundled into the browser. The values the browser
 * legitimately needs (none of the secrets, no Supabase keys) are served by the
 * BFF itself.
 *
 * Required:
 *   SUPABASE_URL              https://<project>.supabase.co
 *   SUPABASE_ANON_KEY         the public anon key (used only for public projections)
 *   BFF_CSRF_SECRET           32+ random characters, unique per deployment
 *   BFF_ALLOWED_ORIGINS       comma-separated exact origins, e.g. https://app.example.com
 *
 * Optional:
 *   BFF_SESSION_IDLE_SECONDS  default 3600
 *   BFF_SESSION_TTL_SECONDS   default 43200 (12 h)
 *   BFF_SESSION_KEY           base64 32-byte key; AES-256-GCM for tokens at rest
 *   BFF_SESSION_STORE         memory | file | postgres (default: infer)
 *   BFF_SESSION_FILE          path for the file store
 *   BFF_DATABASE_URL          Postgres connection string for the postgres store
 *   BFF_MANIFEST_SECRET       HMAC key used ONLY on the server to sign manifests
 *   BFF_STATIC_DIR            directory of the built SPA to serve (same origin)
 *   BFF_INSECURE_COOKIES=1    local HTTP development only; refused in production
 *   BFF_TRUST_PROXY=1         honour X-Forwarded-For (only behind a trusted proxy)
 *   BFF_COOKIE_SAMESITE       Lax (default) | Strict
 */

import { MIN_CSRF_SECRET_LENGTH } from "./tokens";

export type SessionStoreKind = "memory" | "file" | "postgres";

export interface BffConfig {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey?: string;
  allowedOrigins: string[];
  secureCookies: boolean;
  cookieSameSite: "Lax" | "Strict";
  sessionTtlSeconds: number;
  sessionIdleSeconds: number;
  /** Refresh the upstream access token this long before it actually expires. */
  refreshSkewSeconds: number;
  csrfSecret: string;
  sessionKey?: Buffer;
  sessionStore: SessionStoreKind;
  sessionFile?: string;
  databaseUrl?: string;
  staticDir?: string;
  trustProxy: boolean;
  manifestSecret?: string;
  manifestKeyId?: string;
  /** Hard cap on a proxied request body. */
  maxBodyBytes: number;
  /** Auth attempts allowed per window, per IP+email. */
  authLimit: { max: number; windowSeconds: number };
  /** Requests allowed per window, per session. */
  apiLimit: { max: number; windowSeconds: number };
  /** Anonymous display traffic (public projection + events). */
  publicLimit: { max: number; windowSeconds: number };
  production: boolean;
}

export type EnvLike = Record<string, string | undefined>;

export class BffConfigError extends Error {}

function required(env: EnvLike, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new BffConfigError(`BFF config: ${name} is required`);
  return value;
}

function int(env: EnvLike, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new BffConfigError(`BFF config: ${name} must be an integer >= ${min}`);
  }
  return parsed;
}

/** Exact origins only: no wildcards, no trailing slash, no paths. */
export function parseOrigins(raw: string): string[] {
  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new BffConfigError(`BFF config: BFF_ALLOWED_ORIGINS entry is not a URL: ${entry}`);
      }
      if (url.origin !== entry.replace(/\/$/, "")) {
        throw new BffConfigError(`BFF config: BFF_ALLOWED_ORIGINS must be bare origins, got ${entry}`);
      }
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        throw new BffConfigError(`BFF config: BFF_ALLOWED_ORIGINS must be https (or localhost), got ${entry}`);
      }
      return url.origin;
    });
  if (origins.length === 0) throw new BffConfigError("BFF config: BFF_ALLOWED_ORIGINS is empty");
  return [...new Set(origins)];
}

export function readBffConfig(env: EnvLike): BffConfig {
  const production = env.NODE_ENV === "production" || env.BFF_PRODUCTION === "1";
  const supabaseUrl = required(env, "SUPABASE_URL").replace(/\/$/, "");
  const anonKey = required(env, "SUPABASE_ANON_KEY");

  const csrfSecret = required(env, "BFF_CSRF_SECRET");
  if (csrfSecret.length < MIN_CSRF_SECRET_LENGTH) {
    throw new BffConfigError(`BFF config: BFF_CSRF_SECRET must be at least ${MIN_CSRF_SECRET_LENGTH} characters`);
  }

  const allowedOrigins = parseOrigins(required(env, "BFF_ALLOWED_ORIGINS"));

  const insecure = env.BFF_INSECURE_COOKIES === "1";
  if (insecure && production) {
    throw new BffConfigError("BFF config: BFF_INSECURE_COOKIES is refused when NODE_ENV=production");
  }

  const sessionKeyRaw = env.BFF_SESSION_KEY?.trim();
  let sessionKey: Buffer | undefined;
  if (sessionKeyRaw) {
    sessionKey = Buffer.from(sessionKeyRaw, "base64");
    if (sessionKey.length !== 32) {
      throw new BffConfigError("BFF config: BFF_SESSION_KEY must be 32 bytes, base64 encoded");
    }
  }

  const databaseUrl = env.BFF_DATABASE_URL?.trim() || undefined;
  const sessionFile = env.BFF_SESSION_FILE?.trim() || undefined;

  const explicitStore = env.BFF_SESSION_STORE?.trim();
  let sessionStore: SessionStoreKind;
  if (explicitStore === "memory" || explicitStore === "file" || explicitStore === "postgres") {
    sessionStore = explicitStore;
  } else if (databaseUrl) {
    sessionStore = "postgres";
  } else if (sessionFile) {
    sessionStore = "file";
  } else {
    sessionStore = "memory";
  }

  if (production && sessionStore === "memory") {
    throw new BffConfigError(
      "BFF config: the memory session store loses every session on restart. Set BFF_DATABASE_URL or BFF_SESSION_FILE.",
    );
  }
  if (production && !sessionKey) {
    throw new BffConfigError(
      "BFF config: BFF_SESSION_KEY is required in production so upstream tokens are encrypted at rest",
    );
  }

  const sameSiteRaw = env.BFF_COOKIE_SAMESITE?.trim();
  const cookieSameSite = sameSiteRaw === "Strict" ? "Strict" : "Lax";

  return {
    supabaseUrl,
    anonKey,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined,
    allowedOrigins,
    secureCookies: !insecure,
    cookieSameSite,
    sessionTtlSeconds: int(env, "BFF_SESSION_TTL_SECONDS", 43_200, 300),
    sessionIdleSeconds: int(env, "BFF_SESSION_IDLE_SECONDS", 3_600, 60),
    refreshSkewSeconds: int(env, "BFF_REFRESH_SKEW_SECONDS", 60, 0),
    csrfSecret,
    sessionKey,
    sessionStore,
    sessionFile,
    databaseUrl,
    staticDir: env.BFF_STATIC_DIR?.trim() || undefined,
    trustProxy: env.BFF_TRUST_PROXY === "1",
    manifestSecret: env.BFF_MANIFEST_SECRET?.trim() || undefined,
    manifestKeyId: env.BFF_MANIFEST_KEY_ID?.trim() || undefined,
    maxBodyBytes: int(env, "BFF_MAX_BODY_BYTES", 8 * 1024 * 1024, 1024),
    authLimit: { max: int(env, "BFF_AUTH_LIMIT", 10, 1), windowSeconds: int(env, "BFF_AUTH_WINDOW_SECONDS", 300, 10) },
    apiLimit: { max: int(env, "BFF_API_LIMIT", 600, 1), windowSeconds: int(env, "BFF_API_WINDOW_SECONDS", 60, 1) },
    publicLimit: { max: int(env, "BFF_PUBLIC_LIMIT", 240, 1), windowSeconds: int(env, "BFF_PUBLIC_WINDOW_SECONDS", 60, 1) },
    production,
  };
}

/**
 * Startup check list. Every failure here is a configuration problem that would
 * otherwise become a security problem at runtime, so `main.ts` refuses to boot.
 */
export function describeConfigGaps(config: BffConfig): string[] {
  const gaps: string[] = [];
  if (!config.secureCookies) gaps.push("cookies are not Secure (BFF_INSECURE_COOKIES=1) — development only");
  if (!config.sessionKey) gaps.push("upstream tokens are stored unencrypted (BFF_SESSION_KEY unset)");
  if (config.sessionStore === "memory") gaps.push("sessions are held in process memory and vanish on restart");
  if (!config.manifestSecret) gaps.push("playlist manifests are issued unsigned (BFF_MANIFEST_SECRET unset)");
  return gaps;
}
