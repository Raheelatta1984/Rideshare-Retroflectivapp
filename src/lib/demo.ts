import type { Driver } from "../types";
import { uid, pairCode } from "./id";
import { DEFAULT_ADMIN_ACCOUNTS, SOURCE_OWNER_EMAIL } from "./access";
import { createDeviceProfile } from "./devices";
import type { CommercialCampaign, DeviceProfile, LegalConsent } from "../types";

export const DEMO_DRIVER: Driver = {
  id: uid("drv"),
  name: "Raheel",
  email: "demo@retroflex.app",
  phone: "+61 451-195-192",
  password: "demo1234",
  city: "Sydney",
  pairCode: pairCode(),
  frontPairCode: pairCode(),
  createdAt: new Date().toISOString(),
  platforms: ["uber", "didi"],
  vehicle: {
    make: "Toyota",
    model: "Prius V",
    color: "Snowhite",
    plate: "CIW37G",
    year: "2012",
  },
  role: "demo",
};

/**
 * Seeds the demo driver into the database if it doesn't exist
 * This ensures there's always a demo account available for testing
 */
export function seedDemoDriver(
  save: (driver: Driver) => void,
  findByEmail: (email: string) => Driver | undefined
) {
  const existing = findByEmail(DEMO_DRIVER.email);
  if (!existing) {
    save(DEMO_DRIVER);
  }
}
/* ---------------------------------------------------------------- admin seed */

/** Env switch: set VITE_SEED_DEFAULT_ADMINS=off to ship without admin logins. */
export function defaultAdminSeedEnabled(): boolean {
  const raw = (import.meta.env?.VITE_SEED_DEFAULT_ADMINS ?? "").toString().trim().toLowerCase();
  return !(raw === "off" || raw === "false" || raw === "0");
}

/** The administrator records provisioned on a fresh install. */
export function defaultAdminDrivers(): Driver[] {
  return DEFAULT_ADMIN_ACCOUNTS.map((account) => ({
    id: uid("drv"),
    name: account.name,
    email: account.email,
    phone: "",
    password: account.password,
    city: "Sydney",
    pairCode: pairCode(),
    frontPairCode: pairCode(),
    createdAt: new Date().toISOString(),
    platforms: ["uber", "didi"],
    vehicle: { make: "Toyota", model: "Prius V", color: "Snow White", plate: "CIW37G", year: "" },
    role: "admin" as const,
  }));
}

/**
 * Creates the default admin accounts if they don't exist yet. Existing
 * accounts are never touched — a user who changed their password keeps it.
 */
export function seedDefaultAdmins(
  save: (driver: Driver) => void,
  findByEmail: (email: string) => Driver | undefined
): void {
  if (!defaultAdminSeedEnabled()) return;
  for (const admin of defaultAdminDrivers()) {
    if (!findByEmail(admin.email)) save(admin);
  }
}

/* ------------------------------------------------------- test-seed campaign */

export const SEED_CAMPAIGN_ID = "cmp_demo_seed";

const SEED_ASSET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#0b0b0c"/>
<rect x="60" y="60" width="1080" height="680" rx="36" fill="none" stroke="#f0b429" stroke-width="6"/>
<text x="600" y="360" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="96" font-weight="700" fill="#f4efe6">DEMO SPOT</text>
<text x="600" y="460" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="44" fill="#f0b429">Retroflex commercial signage</text>
<text x="600" y="600" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="32" fill="#9a9a9a">Seeded for testing — replace with a real campaign</text>
</svg>`;

export function seedCampaignAssetDataUrl(): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(SEED_ASSET_SVG)}`;
}

function signedConsent(signerName: string, agreementReference: string, email?: string): LegalConsent {
  const at = Date.now();
  return {
    confirmed: true,
    signerName,
    agreementReference,
    email,
    confirmedAt: at,
    signedDocumentAt: at,
    deliveryStatus: "delivered",
  };
}

/**
 * A campaign that passes every gate the display applies: static image, dwell
 * above the NSW floor, all six consents signed, approved in both the local
 * settings and the backend, no referral terms and no geographic rule.
 */
export function buildSeedCampaign(
  now: number = Date.now(),
  complianceMode: "regulated" | "unregulated" = "regulated"
): CommercialCampaign {
  const reference = "RF-DEMO-0001";
  return {
    id: SEED_CAMPAIGN_ID,
    title: complianceMode === "unregulated" ? "Demo spot — unregulated test" : "Demo spot — Retroflex",
    mediaType: "image",
    assetDataUrl: seedCampaignAssetDataUrl(),
    displaySeconds: 12,
    enabled: true,
    approved: true,
    complianceMode,
    approval: { state: "approved", reviewer: "seeded demo campaign", reviewedAt: now },
    target: "rear",
    brightnessCap: 80,
    createdAt: now,
    updatedAt: now,
    legal: {
      appOwner: signedConsent("Raheel Atta", reference, SOURCE_OWNER_EMAIL),
      driver: signedConsent("Raheel Atta", reference),
      vehicleOwner: signedConsent("Raheel Atta", reference),
      campaignOwner: signedConsent("Demo Merchant", reference),
      trademarkAuthorization: signedConsent("Demo Merchant", reference),
      safetyAssessment: signedConsent("Raheel Atta", reference),
      merchantName: "Demo Merchant",
      offerExpiry: "",
      privacyPolicyUrl: "https://retroflex.app/privacy",
      qrTermsConfirmed: false,
      noRiderDataWithoutConsent: true,
      driverIsVehicleOwner: true,
    },
  };
}

/**
 * Switches the rear profile for a pair code onto a commercial playlist and
 * assigns the campaign to it. This is the step people miss: the display only
 * reads campaigns listed in that device profile.
 */
export function enableCommercialOnProfile(
  profiles: DeviceProfile[],
  input: { pairCode: string; campaignId: string; apps?: string[] }
): DeviceProfile[] {
  const index = profiles.findIndex(
    (profile) => profile.pairCode === input.pairCode && profile.position === "rear" && !profile.deviceId
  );

  const base =
    index >= 0
      ? profiles[index]
      : createDeviceProfile({
          pairCode: input.pairCode,
          position: "rear",
          apps: input.apps,
          label: `Rear pair ${input.pairCode}`,
        });

  const next: DeviceProfile = {
    ...base,
    commercialEnabled: true,
    commercialParkedConfirmed: true,
    campaignIds: [...new Set([...(base.campaignIds ?? []), input.campaignId])],
  };

  return index >= 0 ? profiles.map((profile, i) => (i === index ? next : profile)) : [...profiles, next];
}
