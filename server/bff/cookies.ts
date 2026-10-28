/**
 * Session cookies.
 *
 * The production cookie is `__Host-rf_session`:
 *
 *   __Host-rf_session=<opaque>; Path=/; Secure; HttpOnly; SameSite=Lax
 *
 * `__Host-` is a browser-enforced prefix: the cookie is only accepted with
 * `Secure`, `Path=/` and no `Domain`, so a subdomain (or a MITM on plain HTTP)
 * cannot set or overwrite it. `HttpOnly` keeps it out of `document.cookie`, so
 * injected script cannot read or exfiltrate the session — that is the property
 * the old localStorage design could not offer.
 *
 * `SameSite=Lax` rather than `Strict`: Strict would drop the cookie on the very
 * first top-level navigation from an external link (an email, a QR code), so a
 * signed-in user would land on a signed-out page and need a reload. Lax still
 * blocks cross-site POST/PUT/DELETE, and every state-changing request also
 * needs the derived CSRF token, so the looser value costs nothing.
 *
 * Local development over plain HTTP cannot set `Secure`, so the server falls
 * back to a `rf_session` cookie when `BFF_INSECURE_COOKIES=1`. That switch is
 * refused when `NODE_ENV=production`.
 */

export const SESSION_COOKIE_NAME = "__Host-rf_session";
export const INSECURE_SESSION_COOKIE_NAME = "rf_session";

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
  sameSite?: "Lax" | "Strict";
  path?: string;
}

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_NAME : INSECURE_SESSION_COOKIE_NAME;
}

/** Parse one cookie value out of a `Cookie:` header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    // Values are base64url; reject anything that could be a header injection.
    if (!/^[A-Za-z0-9_-]*$/.test(raw)) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function serializeSessionCookie(token: string, options: CookieOptions): string {
  const parts = [
    `${sessionCookieName(options.secure)}=${token}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `SameSite=${options.sameSite ?? "Lax"}`,
    "HttpOnly",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Same attributes as the set cookie, with an already-expired Max-Age. */
export function clearSessionCookie(options: Omit<CookieOptions, "maxAgeSeconds">): string {
  return serializeSessionCookie("", { ...options, maxAgeSeconds: 0 });
}

/** The `Set-Cookie` header value that must never be produced. */
export function assertCookieAttributes(header: string, secure: boolean): void {
  const lower = header.toLowerCase();
  if (!lower.includes("httponly")) throw new Error(`cookie is missing HttpOnly: ${header}`);
  if (!lower.includes("samesite")) throw new Error(`cookie is missing SameSite: ${header}`);
  if (!lower.includes("path=/")) throw new Error(`cookie is missing Path=/: ${header}`);
  if (secure && !lower.includes("secure")) throw new Error(`cookie is missing Secure: ${header}`);
  if (secure && !header.startsWith(`${SESSION_COOKIE_NAME}=`)) {
    throw new Error(`production cookie must use the __Host- prefix: ${header}`);
  }
  if (/;\s*domain=/i.test(header)) throw new Error(`a __Host- cookie must not set Domain: ${header}`);
}
