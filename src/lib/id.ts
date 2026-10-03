// Utility functions for generating unique IDs and pairing codes

/**
 * Generate a unique ID with a prefix
 * @param prefix - The prefix to add (e.g., 'drv' for driver, 'ride' for ride)
 * @returns A unique ID like 'drv_abc123xyz'
 */
export function uid(prefix: string): string {
  const timestamp = Date.now().toString(36); // Convert timestamp to base36
  const randomPart = Math.random().toString(36).slice(2, 9); // Random alphanumeric
  return `${prefix}_${timestamp}${randomPart}`;
}

/**
 * Generate a pairing code (6 uppercase alphanumeric characters)
 * Used for connecting driver phone to rear tablet display
 * @returns A 6-character pairing code like 'A1B2C3'
 */
export function pairCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Format a pair code for display (adds a space in the middle)
 * e.g. "A1B2C3" → "A1B 2C3"
 */
export function formatPair(code: string | null | undefined): string {
  if (!code) return "";
  const cleaned = code.replace(/\s+/g, "").toUpperCase();
  if (cleaned.length <= 3) return cleaned;
  return `${cleaned.slice(0, 3)} ${cleaned.slice(3)}`;
}

/**
 * Validate a pairing code format
 * @param code - The code to validate
 * @returns true if code is 6 uppercase alphanumeric characters
 */
export function isValidPairCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code);
}

/**
 * Generate a short verification code (4 digits)
 * Used for password reset verification
 * @returns A 4-digit numeric code like '1234'
 */
export function verificationCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/* ------------------------------------------------------------------ *
 * Sync identities — phone (host) ↔ tablet (display)
 * ------------------------------------------------------------------ */

export type SyncRole = "host" | "display";

/**
 * Normalise a pair code for use inside a peer id / channel name.
 */
export function normalizePairCode(code: string | null | undefined): string {
  return (code ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Deterministic PeerJS peer id for a given pair code and role.
 *
 * Deterministic on purpose: the phone needs to know up-front which peer id
 * to dial, otherwise it can only guess (the previous implementation built a
 * wildcard target that was never used and could never match a real peer).
 *
 * host    → retroflex-7K2M9Q-host
 * display → retroflex-7K2M9Q-display
 */
export function peerId(role: SyncRole, code: string): string {
  return `retroflex-${normalizePairCode(code)}-${role}`;
}

/**
 * Unique packet id used for ack tracking.
 * Format: pkt_<base36 timestamp>_<random>
 */
export function packetId(): string {
  return `pkt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Console tag for a pair channel, e.g. "[Retroflex 7K2M9Q/host]".
 */
export function relayTag(code: string | null | undefined, role: string): string {
  return `[Retroflex ${normalizePairCode(code)}/${role}]`;
}
