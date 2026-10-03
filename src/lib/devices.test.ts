import { describe, expect, it } from "vitest";
import { codeProfileId, createDeviceProfile, deviceProfileId, normalizeDeviceProfile, profileForDevice } from "./devices";
import type { Device, DeviceProfile } from "../types";

const device: Device = {
  id: "tab_123",
  name: "Rear tablet",
  pairCode: "7K2M9Q",
  position: "rear",
  lastSeen: 1_700_000_000_000,
};

describe("createDeviceProfile", () => {
  it("materialises every field the UI reads unguarded", () => {
    const profile = createDeviceProfile({ pairCode: "7K2M9Q" });
    expect(profile.id).toBe(codeProfileId("7K2M9Q", "rear"));
    expect(profile.position).toBe("rear");
    expect(profile.apps).toEqual([]);
    expect(profile.brightness).toBe(70);
    expect(profile.displayDurationSeconds).toBe(30);
    expect(profile.blankDurationSeconds).toBe(5);
    expect(profile.includeBlank).toBe(false);
    expect(profile.powered).toBe(true);
  });

  it("honours explicit values and carries deviceId through", () => {
    const profile = createDeviceProfile({
      id: deviceProfileId("tab_123", "front"),
      pairCode: "7K2M9Q",
      position: "front",
      deviceId: "tab_123",
      apps: ["uber", "didi"],
      brightness: 40,
    });
    expect(profile.deviceId).toBe("tab_123");
    expect(profile.position).toBe("front");
    expect(profile.apps).toEqual(["uber", "didi"]);
    expect(profile.brightness).toBe(40);
  });
});

describe("profile ids", () => {
  // Regression: deviceProfileId() used to return one constant string for every
  // device (`\( {device.pairCode}: \){device.position}`), so all tablets shared
  // a single profile record and overwrote each other's settings.
  it("gives every device its own id", () => {
    expect(deviceProfileId("tab_123")).not.toBe(deviceProfileId("tab_456"));
    expect(deviceProfileId("tab_123", "rear")).not.toBe(deviceProfileId("tab_123", "front"));
    expect(deviceProfileId("tab_123")).toBe("device:tab_123:rear");
  });

  it("does not leak template placeholders", () => {
    expect(deviceProfileId("tab_123")).not.toContain("{");
    expect(codeProfileId("7K2M9Q")).not.toContain("{");
  });

  // Front and rear screens must never share one profile record.
  it("separates front and rear profiles for one pair code", () => {
    expect(codeProfileId("7K2M9Q", "rear")).not.toBe(codeProfileId("7K2M9Q", "front"));
    expect(codeProfileId("7K2M9Q", "rear")).toBe("profile:7K2M9Q:rear");
  });
});

describe("profileForDevice", () => {
  const byDevice: DeviceProfile = createDeviceProfile({
    id: deviceProfileId("tab_123", "rear"),
    pairCode: "7K2M9Q",
    position: "rear",
    deviceId: "tab_123",
    label: "Rear · kitchen tablet",
  });
  const byPair: DeviceProfile = createDeviceProfile({
    id: codeProfileId("7K2M9Q", "rear"),
    pairCode: "7K2M9Q",
    position: "rear",
    label: "Rear pair 7K2M9Q",
  });

  it("returns null when there is nothing configured", () => {
    expect(profileForDevice([], device, "7K2M9Q", "rear")).toBeNull();
    expect(profileForDevice(undefined, device, "7K2M9Q", "rear")).toBeNull();
  });

  it("prefers the exact device match over the pair-code fallback", () => {
    const found = profileForDevice([byPair, byDevice], device, "7K2M9Q", "rear");
    expect(found?.id).toBe(byDevice.id);
  });

  it("falls back to the pair-code profile before the tablet has announced itself", () => {
    const found = profileForDevice([byPair], device, "7K2M9Q", "rear");
    expect(found?.id).toBe(byPair.id);
  });

  it("matches on position as well as code", () => {
    expect(profileForDevice([byPair], device, "7K2M9Q", "front")).toBeNull();
  });

  it("still matches by code when the device is unknown", () => {
    const found = profileForDevice([byPair], undefined, "7K2M9Q", "rear");
    expect(found?.id).toBe(byPair.id);
  });
});

describe("stored profile repair", () => {
  /**
   * Regression: a device profile saved by an older build (no `apps`, no
   * `campaignIds`, no dwell fields) threw "Cannot read properties of undefined
   * (reading 'includes')" while the console rendered, which blanked the whole
   * app — every control stopped responding, including the live screen mirror.
   */
  it("repairs a bare legacy record into a complete profile", () => {
    const legacy = { id: "profile:7K2M9Q:rear", pairCode: "7K2M9Q", position: "rear", powered: true } as never;
    const profile = normalizeDeviceProfile(legacy);

    expect(profile.apps).toEqual([]);
    expect(profile.campaignIds).toEqual([]);
    expect(profile.displayDurationSeconds).toBe(30);
    expect(profile.blankDurationSeconds).toBe(5);
    expect(profile.commercialEnabled).toBe(false);
    expect(profile.commercialParkedConfirmed).toBe(false);
    // The fields the console renders unguarded must exist and be usable.
    expect(profile.apps.includes("uber")).toBe(false);
    expect(profile.displayDurationSeconds.toFixed(1)).toBe("30.0");
  });

  it("survives junk types instead of trusting them", () => {
    const broken = normalizeDeviceProfile({
      pairCode: "ABC123",
      position: "rear",
      apps: "uber" as never,
      campaignIds: [1, "cmp_ok", null] as never,
      brightness: Number.NaN,
      displayDurationSeconds: "12" as never,
      powered: "yes" as never,
      commercialEnabled: 1 as never,
    });

    expect(broken.apps).toEqual([]);
    expect(broken.campaignIds).toEqual(["cmp_ok"]);
    expect(broken.brightness).toBe(70);
    expect(broken.displayDurationSeconds).toBe(30);
    expect(broken.powered).toBe(true);
    expect(broken.commercialEnabled).toBe(false);
  });

  it("keeps good values untouched", () => {
    const original = createDeviceProfile({
      pairCode: "7K2M9Q",
      position: "rear",
      apps: ["uber", "didi"],
      brightness: 42,
      displayDurationSeconds: 12,
      commercialEnabled: true,
      campaignIds: ["cmp_demo_seed"],
      commercialParkedConfirmed: true,
    });
    expect(normalizeDeviceProfile(original)).toEqual(original);
  });

  it("hands back a complete profile from profileForDevice", () => {
    const stored = [{ id: "profile:7K2M9Q:rear", pairCode: "7K2M9Q", position: "rear" } as never];
    const found = profileForDevice(stored, undefined, "7K2M9Q", "rear");
    expect(found?.apps).toEqual([]);
    expect(found?.displayDurationSeconds).toBe(30);
  });
});
