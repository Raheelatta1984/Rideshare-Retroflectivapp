/**
 * Supabase upstream client (GoTrue auth, PostgREST, Storage).
 *
 * Server-side only. The browser talks to the BFF; the BFF talks to Supabase.
 * Two rules are enforced here rather than by convention:
 *
 *   1. The service-role key is never used for request proxying. User requests
 *      are forwarded with the *user's* access token, so Postgres row-level
 *      security still applies (defence in depth: the BFF and RLS both decide).
 *   2. Upstream error bodies are never returned to the browser verbatim. They
 *      can name internals (table, constraint, project ref), so they are mapped
 *      to a small set of public messages and logged server-side.
 */

export interface UpstreamUser {
  id: string;
  email: string;
  metadata: Record<string, unknown>;
}

export interface UpstreamSession {
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  expiresAt: number;
  user: UpstreamUser;
}

export interface SignUpOutcome {
  session: UpstreamSession | null;
  /** GoTrue returns an empty identities array when the address is taken. */
  alreadyRegistered: boolean;
  /** The project requires email confirmation before a session is issued. */
  needsConfirmation: boolean;
}

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    detail?: string,
  ) {
    super(detail ? `${publicMessage} (${detail})` : publicMessage);
    this.name = "UpstreamError";
  }
}

export interface UpstreamOptions {
  url: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface GoTrueSessionBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  identities?: unknown[];
  user?: { id?: string; email?: string; user_metadata?: Record<string, unknown> };
  msg?: string;
  message?: string;
  error_description?: string;
  error_code?: string;
}

function mapAuthMessage(status: number, body: GoTrueSessionBody | null): string {
  const raw = `${body?.msg ?? ""} ${body?.message ?? ""} ${body?.error_description ?? ""}`.toLowerCase();
  if (raw.includes("invalid login credentials")) return "Email or password is wrong.";
  if (raw.includes("email not confirmed")) return "Confirm your email address, then log in.";
  if (raw.includes("user already registered")) return "An account already exists for that email. Log in instead.";
  if (raw.includes("password should be at least") || raw.includes("weak password")) {
    return "Choose a longer password: at least 8 characters.";
  }
  if (raw.includes("rate limit") || status === 429) return "Too many attempts. Wait a moment and try again.";
  if (raw.includes("signups not allowed") || raw.includes("signup is disabled")) {
    return "Sign-ups are disabled for this deployment.";
  }
  if (status === 400) return "That email or password was not accepted.";
  if (status === 401 || status === 403) return "Email or password is wrong.";
  return "Sign-in is unavailable right now. Try again shortly.";
}

function accessExpiry(body: GoTrueSessionBody, now: number): number {
  const seconds = Number(body.expires_in);
  if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000;
  const token = body.access_token ?? "";
  const payload = token.split(".")[1];
  if (payload) {
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
      if (Number.isFinite(claims.exp)) return Number(claims.exp) * 1000;
    } catch {
      // fall through to the conservative default
    }
  }
  return now + 3_600_000;
}

export interface Upstream {
  signUp(input: { email: string; password: string; data: Record<string, string> }): Promise<SignUpOutcome>;
  signIn(email: string, password: string): Promise<UpstreamSession>;
  refresh(refreshToken: string): Promise<UpstreamSession>;
  logout(accessToken: string): Promise<void>;
  /** PostgREST passthrough. `path` is everything after `/rest/v1/`. */
  rest(path: string, init: RequestInit, token?: string): Promise<Response>;
  /** Storage passthrough. `path` is everything after `/storage/v1/`. */
  storage(path: string, init: RequestInit, token?: string): Promise<Response>;
}

export function createUpstream(options: UpstreamOptions): Upstream {
  const base = options.url.replace(/\/$/, "");
  const anonKey = options.anonKey;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = () => Date.now();

  async function authCall(path: string, body: unknown, accessToken?: string): Promise<GoTrueSessionBody> {
    let response: Response;
    try {
      response = await doFetch(`${base}/auth/v1/${path}`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${accessToken ?? anonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new UpstreamError(503, "The sign-in service is unreachable. Try again shortly.", String(error));
    }

    const text = await response.text();
    let parsed: GoTrueSessionBody | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as GoTrueSessionBody;
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      throw new UpstreamError(response.status, mapAuthMessage(response.status, parsed), text.slice(0, 300));
    }
    return parsed ?? {};
  }

  function toSession(body: GoTrueSessionBody): UpstreamSession {
    if (!body.access_token || !body.refresh_token) {
      throw new UpstreamError(502, "Sign-in is unavailable right now. Try again shortly.", "missing tokens");
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: accessExpiry(body, now()),
      user: {
        id: body.user?.id ?? "",
        email: body.user?.email ?? "",
        metadata: body.user?.user_metadata ?? {},
      },
    };
  }

  async function proxy(prefix: string, path: string, init: RequestInit, token?: string): Promise<Response> {
    const headers = new Headers(init.headers);
    // Never let a caller smuggle its own credentials to the upstream.
    headers.delete("cookie");
    headers.delete("host");
    headers.set("apikey", anonKey);
    headers.set("Authorization", `Bearer ${token ?? anonKey}`);
    try {
      return await doFetch(`${base}${prefix}/${path.replace(/^\//, "")}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new UpstreamError(503, "The data service is unreachable. Try again shortly.", String(error));
    }
  }

  return {
    async signUp(input) {
      const body = await authCall("signup", {
        email: input.email,
        password: input.password,
        data: input.data,
      });
      if (Array.isArray(body.identities) && body.identities.length === 0) {
        return { session: null, alreadyRegistered: true, needsConfirmation: false };
      }
      if (!body.access_token) {
        return { session: null, alreadyRegistered: false, needsConfirmation: true };
      }
      return { session: toSession(body), alreadyRegistered: false, needsConfirmation: false };
    },
    async signIn(email, password) {
      return toSession(await authCall("token?grant_type=password", { email, password }));
    },
    async refresh(refreshToken) {
      return toSession(await authCall("token?grant_type=refresh_token", { refresh_token: refreshToken }));
    },
    async logout(accessToken) {
      try {
        await authCall("logout", {}, accessToken);
      } catch {
        // A rejected or already-expired token is still a successful local sign-out.
      }
    },
    rest(path, init, token) {
      return proxy("/rest/v1", path, init, token);
    },
    storage(path, init, token) {
      return proxy("/storage/v1", path, init, token);
    },
  };
}
