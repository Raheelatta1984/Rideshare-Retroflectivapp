import { describe, expect, it } from "vitest";
import {
  DEMO_DRIVER,
  SEED_CAMPAIGN_ID,
  buildSeedCampaign,
  defaultAdminDrivers,
  defaultAdminSeedEnabled,
  enableCommercialOnProfile,
  seedCampaignAssetDataUrl,
  seedDefaultAdmins,
} from "./demo";
import { DEFAULT_ADMIN_ACCOUNTS, isCommercialOperator, isDefaultAdmin, resolvedRole } from "./access";
import { campaignBlockReasons, campaignIsComplianceReady, isSafeAssetUrl, REQUIRED_CONSENTS } from "./signage";
import type { DeviceProfile, Driver } from "../types";

/** Minimal in-memory stand-in for the storage layer's driver table. */
function driverTable() {
  const rows: Driver[] = [];
  return {
    rows,
    save: (driver: Driver) => {
      const index = rows.findIndex((row) => row.email === driver.email);
      if (index >= 0) rows[index] = driver;
      else rows.push(driver);
    },
    findByEmail: (email: string) => rows.find((row) => row.email === email),
  };
}

describe("default admin accounts", () => {
  it("ships the requested administrator", () => {
    const admin = DEFAULT_ADMIN_ACCOUNTS.find((account) => account.email === "tic.raheel@gmail.com");
    expect(admin).toBeDefined();
    expect(admin?.password).toBe("Abc@123");
  });

  it("resolves the seeded email to the admin role, whatever the record says", () => {
    expect(resolvedRole("tic.raheel@gmail.com", "driver")).toBe("admin");
    expect(resolvedRole("TIC.RAHEEL@Gmail.com", undefined)).toBe("admin");
    expect(resolvedRole("tic.raheel@gmail.com ", "driver")).toBe("admin");
    expect(isDefaultAdmin("tic.raheel@gmail.com")).toBe(true);
    expect(isCommercialOperator("tic.raheel@gmail.com")).toBe(true);
    // Unknown accounts keep their stored role.
    expect(resolvedRole("someone@example.com", "supervisor")).toBe("supervisor");
    expect(isCommercialOperator("someone@example.com")).toBe(false);
  });

  it("keeps the source vault with the source owner only", () => {
    expect(isCommercialOperator("raheel@retroflex.app")).toBe(true);
    expect(isDefaultAdmin("raheel@retroflex.app")).toBe(false);
  });

  it("seeds the admin with a usable password and admin role", () => {
    const db = driverTable();
    seedDefaultAdmins(db.save, db.findByEmail);

    const seeded = db.findByEmail("tic.raheel@gmail.com");
    expect(seeded?.password).toBe("Abc@123");
    expect(seeded?.role).toBe("admin");
    expect(seeded?.pairCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("never overwrites an account that already exists", () => {
    const db = driverTable();
    db.save({ ...DEMO_DRIVER, email: "tic.raheel@gmail.com", password: "changed-by-the-user" });

    seedDefaultAdmins(db.save, db.findByEmail);

    expect(db.findByEmail("tic.raheel@gmail.com")?.password).toBe("changed-by-the-user");
    expect(db.rows).toHaveLength(1);
  });

  it("is idempotent across repeated boots", () => {
    const db = driverTable();
    seedDefaultAdmins(db.save, db.findByEmail);
    seedDefaultAdmins(db.save, db.findByEmail);
    expect(db.rows).toHaveLength(defaultAdminDrivers().length);
  });

  it("can be switched off for a build that must not ship admin logins", () => {
    // Default (unset env) is on; the switch itself is exercised through the helper.
    expect(typeof defaultAdminSeedEnabled()).toBe("boolean");
    expect(defaultAdminSeedEnabled()).toBe(true);
  });
});

describe("seed campaign", () => {
  it("uses a static image asset the display will accept", () => {
    const campaign = buildSeedCampaign();
    expect(campaign.mediaType).toBe("image");
    expect(isSafeAssetUrl(campaign.assetDataUrl)).toBe(true);
    expect(seedCampaignAssetDataUrl().startsWith("data:image/svg+xml")).toBe(true);
  });

  it("carries a signed record for every required consent", () => {
    const campaign = buildSeedCampaign();
    for (const [key] of REQUIRED_CONSENTS) {
      const consent = campaign.legal?.[key];
      expect(consent?.confirmed, key).toBe(true);
      expect(consent?.signerName.trim(), key).toBeTruthy();
      expect(consent?.agreementReference.trim(), key).toBeTruthy();
    }
    expect(campaignIsComplianceReady(campaign)).toBe(true);
  });

  it("passes every gate the NSW rear display applies", () => {
    const campaign = buildSeedCampaign();
    const reasons = campaignBlockReasons(campaign, {
      nswSafetyMode: true,
      position: "rear",
      parkedConfirmed: true,
      now: Date.now(),
    });
    expect(reasons).toEqual([]);
  });

  it("is blocked in the exact ways a tester might otherwise hit", () => {
    const campaign = buildSeedCampaign();
    const base = { nswSafetyMode: true, position: "rear" as const, now: Date.now() };

    // Parked confirmation is per device and required under NSW safety mode.
    expect(campaignBlockReasons(campaign, { ...base, parkedConfirmed: false })).toContain(
      "parked-confirmation-missing"
    );
    // It targets the rear glass, so a front screen must refuse it.
    expect(campaignBlockReasons(campaign, { ...base, parkedConfirmed: true, position: "front" })).toContain(
      "wrong-position"
    );
    // Unapproved is unapproved.
    expect(
      campaignBlockReasons({ ...campaign, approval: { state: "pending" }, approved: false }, { ...base, parkedConfirmed: true })
    ).toContain("not-approved");
    // The dwell floor holds even if someone edits the record.
    expect(campaign.displaySeconds).toBeGreaterThanOrEqual(10);
  });
});

describe("commercial profile assignment", () => {
  const pairCode = "7K2M9Q";

  it("creates a rear profile when the device has none yet", () => {
    const profiles = enableCommercialOnProfile([], { pairCode, campaignId: SEED_CAMPAIGN_ID });
    const rear = profiles.find((profile) => profile.pairCode === pairCode && profile.position === "rear");

    expect(rear).toBeDefined();
    expect(rear?.commercialEnabled).toBe(true);
    expect(rear?.commercialParkedConfirmed).toBe(true);
    expect(rear?.campaignIds).toEqual([SEED_CAMPAIGN_ID]);
  });

  it("updates the existing rear profile without duplicating it", () => {
    const existing = enableCommercialOnProfile([], { pairCode, campaignId: SEED_CAMPAIGN_ID });
    const again = enableCommercialOnProfile(existing, { pairCode, campaignId: SEED_CAMPAIGN_ID });

    expect(again).toHaveLength(1);
    expect(again[0].campaignIds).toEqual([SEED_CAMPAIGN_ID]);
  });

  it("assigns a second campaign alongside the first", () => {
    const first = enableCommercialOnProfile([], { pairCode, campaignId: SEED_CAMPAIGN_ID });
    const second = enableCommercialOnProfile(first, { pairCode, campaignId: "cmp_other" });

    expect(second).toHaveLength(1);
    expect(second[0].campaignIds).toEqual([SEED_CAMPAIGN_ID, "cmp_other"]);
  });

  it("leaves a real tablet profile alone — only the pair-code profile is switched", () => {
    const deviceProfile: DeviceProfile = {
      id: "device:tablet-1:rear",
      pairCode,
      position: "rear",
      deviceId: "tablet-1",
      powered: true,
      apps: [],
      brightness: 70,
      adaptiveBrightness: false,
      displayDurationSeconds: 30,
      includeBlank: false,
      blankDurationSeconds: 5,
      commercialEnabled: false,
      campaignIds: [],
      passengerNameEnabled: false,
    };
    const profiles = enableCommercialOnProfile([deviceProfile], { pairCode, campaignId: SEED_CAMPAIGN_ID });

    expect(profiles).toHaveLength(2);
    expect(profiles[0].commercialEnabled).toBe(false);
    expect(profiles[0].campaignIds).toEqual([]);
  });
});

describe("seed campaign under the legal pack switch", () => {
  it("is stamped unregulated and titled as a test when the pack is off", () => {
    const campaign = buildSeedCampaign(Date.now(), "unregulated");
    expect(campaign.complianceMode).toBe("unregulated");
    expect(campaign.title).toMatch(/unregulated/i);
    // Still shows immediately even with the pack back on, and still shows if
    // the safety mode demands a parked confirmation.
    expect(
      campaignBlockReasons(campaign, { nswSafetyMode: true, position: "rear", parkedConfirmed: true, legalPackEnabled: true })
    ).toEqual([]);
  });

  it("defaults to a regulated campaign", () => {
    expect(buildSeedCampaign().complianceMode).toBe("regulated");
  });

  it("keeps a regulated, unsigned campaign blocked while the pack is on", () => {
    const regulated = { ...buildSeedCampaign(), legal: undefined, approved: false, approval: undefined };
    expect(
      campaignBlockReasons(regulated, { nswSafetyMode: true, position: "rear", parkedConfirmed: true, legalPackEnabled: true })
    ).not.toEqual([]);
  });
});
