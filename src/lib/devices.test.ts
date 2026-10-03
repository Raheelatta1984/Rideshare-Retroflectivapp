import { describe, expect, it } from "vitest";
import { codeProfileId, createDeviceProfile, deviceProfileId, profileForDevice } from "./devices";
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
