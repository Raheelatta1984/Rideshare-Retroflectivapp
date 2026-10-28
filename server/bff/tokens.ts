/**
 * Opaque session and CSRF tokens.
 *
 * Session tokens are 256 bits from the OS CSPRNG, base64url encoded. Only the
 * SHA-256 hash of a token is ever stored, so a dump of the session table (or a
 * backup, or a replica) cannot be replayed as a live session.
 *
 * CSRF tokens are derived — HMAC-SHA256(csrfSecret, sessionTokenHash) — rather
 * than stored, so rotating or losing them costs nothing and a stale token for a
 * different session can never validate.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Bytes of entropy in a session token. 32 bytes = 256 bits. */
export const SESSION_TOKEN_BYTES = 32;

/** Minimum length of the server-side CSRF secret. */
export const MIN_CSRF_SECRET_LENGTH = 32;

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/** Stable, non-reversible handle for a token. This is the session primary key. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function csrfFor(sessionTokenHash: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionTokenHash}`, "utf8").digest("base64url");
}

/** Constant-time comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still touch both buffers so the failure cost does not depend on prefix.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Shape check before a token is used. A malformed cookie must be rejected
 * cheaply and must never reach a database query as an unbounded string.
 */
export function looksLikeSessionToken(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
