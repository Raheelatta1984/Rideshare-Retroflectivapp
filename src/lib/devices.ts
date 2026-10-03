import type { Device, DeviceProfile, DeviceProfileInput } from "../types";

export function createDeviceProfile(input: DeviceProfileInput): DeviceProfile {
  const position = input.position ?? "rear";
  const id = input.id ?? codeProfileId(input.pairCode, position);

  return {
    id,
    pairCode: input.pairCode,
    position,
    deviceId: input.deviceId,
    label: input.label ?? `Device ${id}`,
    powered: input.powered ?? true,
    apps: input.apps ?? [],
    brightness: input.brightness ?? 70,
    adaptiveBrightness: input.adaptiveBrightness ?? false,
    displayDurationSeconds: input.displayDurationSeconds ?? 30,
    includeBlank: input.includeBlank ?? false,
    blankDurationSeconds: input.blankDurationSeconds ?? 5,
    commercialEnabled: input.commercialEnabled ?? false,
    campaignIds: input.campaignIds ?? [],
    commercialParkedConfirmed: input.commercialParkedConfirmed ?? false,
    passengerNameEnabled: input.passengerNameEnabled ?? false,
    passengerName: input.passengerName,
  };
}

/**
 * Stable profile id for the primary profile that belongs to a pair code.
 *
 * The position is part of the id: front and rear are different screens and
 * must never share (and overwrite) one profile record.
 */
export function codeProfileId(pairCode: string, position: "rear" | "front" = "rear"): string {
  return `profile:${(pairCode ?? "").toUpperCase()}:${position}`;
}

/**
 * Stable profile id for a physical device that announced itself over sync.
 */
export function deviceProfileId(deviceId: string, position: "rear" | "front" = "rear"): string {
  return `device:${deviceId}:${position}`;
}

export function profileForDevice(
  deviceProfiles: DeviceProfile[] | null | undefined,
  device: Device | undefined,
  pairCode: string,
  position: "rear" | "front",
): DeviceProfile | null {
  if (!deviceProfiles || deviceProfiles.length === 0) return null;

  if (device) {
    const exactMatch = deviceProfiles.find(
      (p) => p.deviceId === device.id && p.position === position,
    );

    if (exactMatch) return exactMatch;
  }

  const pairMatch = deviceProfiles.find(
    (p) => p.pairCode === pairCode && p.position === position,
  );

  return pairMatch ?? null;
}
