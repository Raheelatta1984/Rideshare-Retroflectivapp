/**
 * Cryptographically random values.
 *
 * `Math.random()` is a PRNG with a predictable state; anything a user is meant
 * to keep secret (a password-reset code, a reset token) must come from the
 * platform CSPRNG instead. `crypto.getRandomValues` exists in every browser the
 * app supports and in Node, and it is not affected by a seeded or restored
 * page state.
 */

const HEX = "0123456789abcdef";

function secureCrypto(): Crypto {
  const value = globalThis.crypto;
  if (!value || typeof value.getRandomValues !== "function") {
    throw new Error("A secure random source (crypto.getRandomValues) is required.");
  }
  return value;
}

/** Raw random bytes. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) throw new RangeError("randomBytes needs a positive length");
  const bytes = new Uint8Array(length);
  secureCrypto().getRandomValues(bytes);
  return bytes;
}

/** Lower-case hex encoding of `bytes` random bytes. */
export function randomHex(bytes = 16): string {
  return Array.from(randomBytes(bytes), (byte) => HEX[byte >> 4] + HEX[byte & 15]).join("");
}

/**
 * `count` decimal digits, uniformly distributed.
 *
 * Bytes at or above the largest multiple of 10 that fits in a byte are
 * discarded (rejection sampling) so 0–5 are not slightly more likely than 6–9.
 */
export function randomDigits(count: number): string {
  if (!Number.isInteger(count) || count <= 0) throw new RangeError("randomDigits needs a positive count");
  let out = "";
  while (out.length < count) {
    for (const byte of randomBytes(count * 2)) {
      if (byte >= 250) continue; // 250 = 25 * 10: discard the biased tail
      out += String(byte % 10);
      if (out.length === count) break;
    }
  }
  return out;
}

/** `reset_` + 128 bits of entropy, the shape the reset records already use. */
export function randomToken(prefix = "reset_", bytes = 16): string {
  return `${prefix}${randomHex(bytes)}`;
}
