import type { Device, DeviceProfile, DeviceProfileInput } from "./types";

export function createDeviceProfile(input: DeviceProfileInput): DeviceProfile {
  return {
    id: input.id,
    pairCode: input.pairCode,
    position: input.position,
    label: input.label ?? `Device ${input.id}`,
    powered: input.powered ?? true,
    apps: input.apps ?? [],
    brightness: input.brightness ?? 70,
    adaptiveBrightness: input.adaptiveBrightness ?? false,
    displayDurationSeconds: input.displayDurationSeconds ?? 30,
    includeBlank: input.includeBlank ?? false,
    blankDurationSeconds: input.blankDurationSeconds ?? 5,
    commercialEnabled: input.commercialEnabled ?? false,
    campaignIds: input.campaignIds ?? [],
    passengerNameEnabled: input.passengerNameEnabled ?? false,
    passengerName: input.passengerName,
  };
}

export function codeProfileId(pairCode: string): string {
  return `profile:${pairCode.toUpperCase()}`;
}

export function deviceProfileId(device: Device): string {
  return `\( {device.pairCode}: \){device.position}`;
}

export function profileForDevice(
  deviceProfiles: DeviceProfile[] | null | undefined,
  device: Device,
  pairCode: string,
  position: "rear" | "front",
): DeviceProfile | null {
  if (!deviceProfiles || deviceProfiles.length === 0) return null;

  const exactMatch = deviceProfiles.find(
    (p) => p.deviceId === device.id && p.position === position,
  );

  if (exactMatch) return exactMatch;

  const pairMatch = deviceProfiles.find(
    (p) => p.pairCode === pairCode && p.position === position,
  );

  return pairMatch ?? null;
}