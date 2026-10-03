// Access control for source vault and demo features

import type { DriverRole } from "../types";

export const SOURCE_OWNER_EMAIL = "raheel@retroflex.app";

export function isSourceOwner(email: string | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase() === SOURCE_OWNER_EMAIL.toLowerCase();
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
  if (isSourceOwner(email)) return "admin";
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
      return isSourceOwner(email);
    default:
      return false;
  }
}