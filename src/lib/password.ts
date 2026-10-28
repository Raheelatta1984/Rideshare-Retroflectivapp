/**
 * Password hashing for the on-device booth accounts.
 *
 * The booth account table lives in `localStorage` (`rf:drivers`), so before this
 * module existed a stolen browser profile — or any script that reached the
 * origin — handed over every password in clear text. Records are now written as
 *
 *   pbkdf2-sha256$<iterations>$<salt base64>$<derived key base64>
 *
 * using PBKDF2-HMAC-SHA256 from WebCrypto (no extra dependency to audit).
 *
 * Two limits are worth stating plainly:
 *
 *   - This does not make the browser an authentication boundary. A same-origin
 *     script can still *use* a signed-in session, and can overwrite the table.
 *     It bounds the damage of a leaked profile: passwords are slow to brute
 *     force and cannot be replayed against the user's other accounts.
 *   - The iteration count is a browser-side trade-off, not a server-side one.
 *     210 000 keeps a login under ~100 ms on a phone while staying well above
 *     the point where a single GPU cracks a decent password quickly.
 */

export const PASSWORD_SCHEME = "pbkdf2-sha256";
export const PASSWORD_ITERATIONS = 210_000;

const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;
const PREFIX = `${PASSWORD_SCHEME}$`;

export interface PasswordVerification {
  /** The password matched the stored credential. */
  ok: boolean;
  /**
   * The stored value should be replaced: it is a legacy clear-text record, or a
   * hash made with an older iteration count. Callers re-hash with the password
   * they just verified and save the record.
   */
  needsRehash: boolean;
}

/** True when the value is one of our hashes rather than a legacy clear-text password. */
export function isPasswordHash(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function hashIterations(value: string): number {
  const [, iterations] = value.split("$");
  const parsed = Number(iterations);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WebCrypto is required to hash passwords.");
  return value;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle().importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    DERIVED_KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Compare two byte arrays without exiting on the first differing byte. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Compare two strings as UTF-8 bytes without exiting on the first difference. */
export function constantTimeEqualText(a: string, b: string): boolean {
  return constantTimeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}

/** Hash a password for storage. Empty input is rejected: it is never a credential. */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error("Cannot store an empty password.");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derive(password, salt, PASSWORD_ITERATIONS);
  return `${PASSWORD_SCHEME}$${PASSWORD_ITERATIONS}$${toBase64(salt)}$${toBase64(key)}`;
}

/**
 * Verify a submitted password against a stored record.
 *
 * Accepts a legacy clear-text record so existing browsers keep working; the
 * caller is told it must re-hash. A missing/empty stored value never matches,
 * which is what makes "seeded, awaiting activation" accounts unusable.
 */
export async function verifyPassword(
  stored: string | null | undefined,
  password: string,
): Promise<PasswordVerification> {
  if (!stored || !password) return { ok: false, needsRehash: false };

  if (!isPasswordHash(stored)) {
    // Legacy record. Constant-time compare so a failed login leaks no prefix.
    return { ok: constantTimeEqualText(stored, password), needsRehash: true };
  }

  const [scheme, iterationsRaw, saltRaw, keyRaw] = stored.split("$");
  const iterations = Number(iterationsRaw);
  if (scheme !== PASSWORD_SCHEME || !Number.isFinite(iterations) || iterations <= 0 || !saltRaw || !keyRaw) {
    return { ok: false, needsRehash: false };
  }

  let salt: Uint8Array<ArrayBuffer>;
  let expected: Uint8Array;
  try {
    salt = fromBase64(saltRaw);
    expected = fromBase64(keyRaw);
  } catch {
    // A truncated or hand-edited record is not a credential; never throw from
    // the login path.
    return { ok: false, needsRehash: false };
  }

  const actual = await derive(password, salt, iterations);
  return {
    ok: constantTimeEqual(actual, expected),
    needsRehash: iterations < PASSWORD_ITERATIONS,
  };
}
