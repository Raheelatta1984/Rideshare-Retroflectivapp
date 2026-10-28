import { normalizeDeviceProfile } from "./devices";
import { constantTimeEqualText } from "./password";
import { randomDigits, randomToken } from "./random";
import type {
  ActivityLog,
  Driver,
  DisplaySettings,
  PasswordResetRecord,
  Ride,
} from "../types";

/**
 * Wrong codes allowed per reset request before the request is burnt. The screen
 * already told the user "five incorrect attempts invalidate the code"; this is
 * the check that makes that sentence true.
 */
const MAX_RESET_ATTEMPTS = 5;

const safeJsonParse = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export function defaultSettings(): DisplaySettings {
  return {
    theme: "night",
    masterOn: false,
    apps: ["uber", "didi"],
    brightness: 70,
    adaptiveBrightness: true,
    displayDurationSeconds: 4.5,
    includeBlank: false,
    blankDurationSeconds: 1.5,
    motionSafetyGate: true,
    stationarySpeedKph: 0.5,
    stationaryWaitSeconds: 60,
    stopDelaySeconds: 30,
    showPlatform: true,
    showPin: true,
    showColorBar: true,
    showLastInitial: true,
    showGreeting: true,
    diagnosticsOverlay: false,
    platformBackgroundMode: "brand",
    wordmarkEmbossed: true,
    fadeTransitions: true,
    nswSafetyMode: true,
    language: "en",
    deviceProfiles: [],
    commercialCampaigns: [],
    includeCommercial: false,
  };
}

export const db = {
  saveDriver: (driver: Driver) => {
    const drivers = db.listDrivers();
    const next = [...drivers.filter((d) => d.id !== driver.id), driver];
    localStorage.setItem("rf:drivers", JSON.stringify(next));
    return driver;
  },

  listDrivers: (): Driver[] => {
    return safeJsonParse<Driver[]>(localStorage.getItem("rf:drivers"), []);
  },

  findByEmail: (email: string) => {
    const drivers = db.listDrivers();
    return drivers.find((d) => d.email.toLowerCase() === email.toLowerCase());
  },

  findById: (id: string) => {
    const drivers = db.listDrivers();
    return drivers.find((d) => d.id === id);
  },

  saveSettings: (driverId: string, settings: DisplaySettings) => {
    const bucket = safeJsonParse<Record<string, DisplaySettings>>(
      localStorage.getItem("rf:settings"),
      {},
    );
    bucket[driverId] = settings;
    localStorage.setItem("rf:settings", JSON.stringify(bucket));
  },

  getSettings: (driverId: string): DisplaySettings => {
    const bucket = safeJsonParse<Record<string, DisplaySettings>>(
      localStorage.getItem("rf:settings"),
      {},
    );
    const saved = bucket[driverId];
    if (!saved) return defaultSettings();
    // Repair on read. A settings record written by an older build can be missing
    // whole keys — a missing `theme` alone crashed the display with
    // "Cannot read properties of undefined (reading 'fg')". Defaults fill every
    // gap; explicit nulls are ignored rather than trusted.
    const defined = Object.fromEntries(
      Object.entries(saved as unknown as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined),
    ) as Partial<DisplaySettings>;
    return {
      ...defaultSettings(),
      ...defined,
      deviceProfiles: (Array.isArray(saved.deviceProfiles) ? saved.deviceProfiles : []).map(normalizeDeviceProfile),
    };
  },

  setSession: (session: { driverId: string } | null) => {
    if (!session) {
      localStorage.removeItem("rf:session");
      return;
    }
    localStorage.setItem("rf:session", JSON.stringify(session));
  },

  getSession: () => {
    return safeJsonParse<{ driverId: string } | null>(
      localStorage.getItem("rf:session"),
      null,
    );
  },

  upsertRide: (ride: Ride) => {
    const rides = db.listRides(ride.driverId);
    const next = [...rides.filter((r) => r.id !== ride.id), ride];
    localStorage.setItem(`rf:rides:${ride.driverId}`, JSON.stringify(next));
  },

  listRides: (driverId: string): Ride[] => {
    return safeJsonParse<Ride[]>(
      localStorage.getItem(`rf:rides:${driverId}`),
      [],
    );
  },

  addActivity: (entry: ActivityLog) => {
    const driverId = entry.driverId ?? "shared";
    const list = db.listActivity(driverId);
    const next = [entry, ...list].slice(0, 200);
    localStorage.setItem(`rf:activity:${driverId}`, JSON.stringify(next));
  },

  listActivity: (driverId: string): ActivityLog[] => {
    return safeJsonParse<ActivityLog[]>(
      localStorage.getItem(`rf:activity:${driverId}`),
      [],
    );
  },

  createPasswordReset: (email: string) => {
    const resets = db.listPasswordResets();
    const existing = resets.find(
      (r) => r.email.toLowerCase() === email.toLowerCase() && !r.usedAt,
    );
    if (existing) return existing;

    // Six digits, as every screen promises, from the platform CSPRNG. A
    // Math.random() code is guessable from a couple of earlier codes.
    const code = randomDigits(6);
    const token = randomToken();
    const record: PasswordResetRecord = {
      email,
      code,
      token,
      createdAt: Date.now(),
      attempts: 0,
    };

    const next = [...resets, record];
    localStorage.setItem("rf:password-resets", JSON.stringify(next));
    return record;
  },

  listPasswordResets: (): PasswordResetRecord[] => {
    return safeJsonParse<PasswordResetRecord[]>(
      localStorage.getItem("rf:password-resets"),
      [],
    );
  },

  verifyPasswordReset: (email: string, code: string) => {
    const resets = db.listPasswordResets();
    const candidate = resets.find(
      (r) => r.email.toLowerCase() === email.toLowerCase() && !r.usedAt,
    );

    if (!candidate) {
      return { error: "Invalid or expired code" };
    }

    const expired = Date.now() - candidate.createdAt >= 30 * 60 * 1000;
    const exhausted = (candidate.attempts ?? 0) >= MAX_RESET_ATTEMPTS;
    if (expired || exhausted) {
      return {
        error: exhausted ? "Too many incorrect attempts. Request a new code." : "Invalid or expired code",
      };
    }

    if (!constantTimeEqualText(candidate.code, code.trim())) {
      const attempts = (candidate.attempts ?? 0) + 1;
      const next = resets.map((r) =>
        r.token === candidate.token ? { ...r, attempts } : r,
      );
      localStorage.setItem("rf:password-resets", JSON.stringify(next));
      return {
        error:
          attempts >= MAX_RESET_ATTEMPTS
            ? "Too many incorrect attempts. Request a new code."
            : "Invalid or expired code",
      };
    }

    const next = resets.map((r) =>
      r.token === candidate.token ? { ...r, verifiedAt: Date.now() } : r,
    );
    localStorage.setItem("rf:password-resets", JSON.stringify(next));
    return { error: null, reset: { ...candidate, verifiedAt: Date.now() } };
  },

  getPasswordReset: (token: string) => {
    const resets = db.listPasswordResets();
    return resets.find((r) => r.token === token);
  },

  /**
   * Apply a verified reset. `passwordHash` must already be hashed (see
   * `src/lib/password.ts`); this layer stores credentials, it does not create
   * them, and nothing here may write a clear-text password.
   */
  completePasswordReset: (token: string, passwordHash: string) => {
    const resets = db.listPasswordResets();
    // Single use, and only after the emailed code proved the mailbox: a replay
    // of an old link must not be able to set a password again.
    const match = resets.find((r) => r.token === token && r.verifiedAt && !r.usedAt);
    if (!match) return null;

    const driver = db.findByEmail(match.email);
    if (!driver) return null;

    const updatedDriver = { ...driver, password: passwordHash };
    db.saveDriver(updatedDriver);

    const next = resets.map((r) =>
      r.token === token ? { ...r, usedAt: Date.now() } : r,
    );
    localStorage.setItem("rf:password-resets", JSON.stringify(next));
    return updatedDriver;
  },

  addTabletActivity: (entry: {
    id: string;
    at: number;
    pairCode: string;
    deviceId: string;
    action: string;
    details?: Record<string, unknown>;
  }) => {
    const key = `rf:tablet-activity:${entry.pairCode}`;
    const current = safeJsonParse<Array<typeof entry>>(
      localStorage.getItem(key),
      [],
    );
    const next = [entry, ...current].slice(0, 100);
    localStorage.setItem(key, JSON.stringify(next));
  },

  /**
   * Local display events for a pair code. Pass a deviceId to narrow the log to
   * one physical tablet (the tablet log screen shows "Device xxxx").
   */
  listTabletActivity: (pairCode: string, deviceId?: string) => {
    const key = `rf:tablet-activity:${pairCode}`;
    const all = safeJsonParse<
      Array<{
        id: string;
        at: number;
        pairCode: string;
        deviceId: string;
        action: string;
        details?: Record<string, unknown>;
      }>
    >(localStorage.getItem(key), []);

    if (!deviceId) return all;
    return all.filter((entry) => entry.deviceId === deviceId);
  },
};