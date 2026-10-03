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
 * Repairs a stored device profile.
 *
 * Profiles written by older builds — or by a partial/remote payload — can be
 * missing fields such as `apps`, `campaignIds` or `displayDurationSeconds`.
 * Reading those records raw crashed the console render, which blanked the whole
 * app. Every profile that comes out of storage or off the wire goes through
 * here, so a bad record degrades to a default instead of killing the screen.
 */
export function normalizeDeviceProfile(raw: Partial<DeviceProfile> | null | undefined): DeviceProfile {
  const record = raw ?? {};
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  const finite = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

  return createDeviceProfile({
    id: typeof record.id === "string" && record.id ? record.id : undefined,
    pairCode: typeof record.pairCode === "string" ? record.pairCode : "",
    position: record.position === "front" || record.position === "rear" ? record.position : undefined,
    deviceId: typeof record.deviceId === "string" ? record.deviceId : undefined,
    label: typeof record.label === "string" ? record.label : undefined,
    powered: flag(record.powered),
    apps: strings(record.apps),
    brightness: finite(record.brightness),
    adaptiveBrightness: flag(record.adaptiveBrightness),
    displayDurationSeconds: finite(record.displayDurationSeconds),
    includeBlank: flag(record.includeBlank),
    blankDurationSeconds: finite(record.blankDurationSeconds),
    commercialEnabled: flag(record.commercialEnabled),
    campaignIds: strings(record.campaignIds),
    commercialParkedConfirmed: flag(record.commercialParkedConfirmed),
    passengerNameEnabled: flag(record.passengerNameEnabled),
    passengerName: typeof record.passengerName === "string" ? record.passengerName : undefined,
  });
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

    if (exactMatch) return normalizeDeviceProfile(exactMatch);
  }

  const pairMatch = deviceProfiles.find(
    (p) => p.pairCode === pairCode && p.position === position,
  );

  return pairMatch ? normalizeDeviceProfile(pairMatch) : null;
}
