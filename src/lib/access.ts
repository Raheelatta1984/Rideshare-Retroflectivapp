// Access control for source vault and demo features

import type { DriverRole } from "../types";

export const SOURCE_OWNER_EMAIL = "raheel@retroflex.app";

/**
 * Administrator identities provisioned the first time the app runs in a
 * browser. They are seeded into local storage on boot (see lib/demo.ts) so a
 * fresh device can reach the admin-only commercial signage tools.
 *
 * Deliberately **no password**: a shared password committed to the repository
 * ships in the bundle to every visitor and is the same secret on every install,
 * so it protects nothing. Seeded accounts are created without a credential and
 * are activated by the owner through "Forgot password" → email code → new
 * password, exactly like the source-owner activation. Until then they cannot be
 * logged into (`verifyPassword` refuses an empty record).
 *
 * These are CLIENT-SIDE roles in a browser build. They gate the admin UI only —
 * the real data boundary is the backend's row level security, not this list.
 * Remove an entry here (or set VITE_SEED_DEFAULT_ADMINS=off) if this build must
 * not ship an administrator login.
 */
export const DEFAULT_ADMIN_ACCOUNTS: ReadonlyArray<{ name: string; email: string }> = [
  { name: "Tic Raheel", email: "tic.raheel@gmail.com" },
];

export function isSourceOwner(email: string | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase() === SOURCE_OWNER_EMAIL.toLowerCase();
}

export function isDefaultAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return DEFAULT_ADMIN_ACCOUNTS.some((account) => account.email.toLowerCase() === normalized);
}

/**
 * Administrators of this build: the source owner plus the seeded default
 * admins. Used to unlock the commercial signage tooling.
 */
export function isAdminEmail(email: string | undefined): boolean {
  return isSourceOwner(email) || isDefaultAdmin(email);
}

/**
 * Who may run commercial campaigns — build the campaign, and assign it to a
 * device. Wider than the source vault, which stays with the owner.
 */
export function isCommercialOperator(email: string | undefined): boolean {
  return isAdminEmail(email);
}

export function canDownloadSource(email: string | undefined): boolean {
  if (!email) return false;
  return isSourceOwner(email);
}

export function isDemoAdmin(email: string | undefined): boolean {
  if (!email) return false;
  return isSourceOwner(email) || email.toLowerCase() === "demo@retroflex.app";
}

export function resolvedRole(email: string | undefined, currentRole: string | undefined): DriverRole {
  if (isAdminEmail(email)) return "admin";
  if (isDemoAdmin(email)) return "demo";
  return (currentRole as DriverRole | undefined) ?? "driver";
}

export function canAccessFeature(
  email: string | undefined,
  feature: "download-source" | "demo" | "admin"
): boolean {
  if (!email) return false;

  switch (feature) {
    case "download-source":
      return canDownloadSource(email);
    case "demo":
      return isDemoAdmin(email);
    case "admin":
      return isAdminEmail(email);
    default:
      return false;
  }
}
