import { beforeEach, describe, expect, it } from "vitest";
import { db, defaultSettings } from "./storage";
import type { ActivityLog, Driver } from "../types";

beforeEach(() => {
  localStorage.clear();
});

describe("defaultSettings", () => {
  it("fills in every stop/blank/motion timing the display reads", () => {
    const settings = defaultSettings();
    expect(settings.stopDelaySeconds).toBeGreaterThan(0);
    expect(settings.displayDurationSeconds).toBeGreaterThan(0);
    expect(settings.blankDurationSeconds).toBeGreaterThan(0);
    expect(settings.stationaryWaitSeconds).toBeGreaterThan(0);
    expect(settings.theme).toBe("night");
  });

  it("returns a fresh object each call", () => {
    const a = defaultSettings();
    a.apps?.push("lyft");
    expect(defaultSettings().apps).not.toContain("lyft");
  });
});

describe("settings round-trip", () => {
  it("persists per driver", () => {
    db.saveSettings("drv_1", { ...defaultSettings(), brightness: 33 });
    expect(db.getSettings("drv_1").brightness).toBe(33);
    expect(db.getSettings("drv_2").brightness).not.toBe(33);
  });
});

describe("activity log", () => {
  it("stores newest first and caps the log", () => {
    for (let i = 0; i < 205; i += 1) {
      db.addActivity({ id: `log_${i}`, at: i, action: `event ${i}`, driverId: "drv_1" });
    }
    const list = db.listActivity("drv_1");
    expect(list).toHaveLength(200);
    expect(list[0].action).toBe("event 204");
  });

  // Regression: write and read paths used the raw (now optional) driverId for
  // the storage key while the reader filtered on it, so entries written without
  // a driverId were invisible.
  it("keeps entries written without a driverId readable", () => {
    db.addActivity({ id: "log_x", at: 1, action: "tablet ping" } as ActivityLog);
    const shared = db.listActivity("shared");
    expect(shared).toHaveLength(1);
    expect(shared[0].action).toBe("tablet ping");
  });

  it("keeps platform and device context on entries", () => {
    db.addActivity({
      id: "log_y",
      at: 2,
      action: "Device profile updated",
      driverId: "drv_1",
      pairCode: "7K2M9Q",
      deviceId: "tab_1",
      deviceName: "Rear · kitchen tablet",
      platforms: ["uber", "didi"],
    });
    const entry = db.listActivity("drv_1")[0];
    expect(entry.deviceId).toBe("tab_1");
    expect(entry.platforms).toEqual(["uber", "didi"]);
  });
});

describe("tablet activity", () => {
  it("returns the pair log, optionally narrowed to one device", () => {
    db.addTabletActivity({ id: "a", at: 1, pairCode: "7K2M9Q", deviceId: "tab_1", action: "wake" });
    db.addTabletActivity({ id: "b", at: 2, pairCode: "7K2M9Q", deviceId: "tab_2", action: "wake" });

    expect(db.listTabletActivity("7K2M9Q")).toHaveLength(2);
    expect(db.listTabletActivity("7K2M9Q", "tab_1")).toHaveLength(1);
    expect(db.listTabletActivity("7K2M9Q", "tab_1")[0].id).toBe("a");
    expect(db.listTabletActivity("OTHERC")).toHaveLength(0);
  });
});

describe("riders", () => {
  it("upserts and lists rides per driver", () => {
    const ride = {
      id: "ride_1",
      driverId: "drv_1",
      platform: "uber",
      passengerFirst: "Sarah",
      passengerLastInitial: "M",
      colorCode: "#fff",
      pin: "1234",
      pickup: "A",
      dropoff: "B",
      fare: "$12",
      etaMinutes: 4,
      status: "incoming" as const,
      createdAt: new Date().toISOString(),
    };
    db.upsertRide(ride);
    db.upsertRide({ ...ride, status: "accepted" });

    const rides = db.listRides("drv_1");
    expect(rides).toHaveLength(1);
    expect(rides[0].status).toBe("accepted");
    expect(db.listRides("drv_2")).toHaveLength(0);
  });
});

describe("password reset credentials", () => {
  const EMAIL = "reset@retroflex.app";

  it("issues a six-digit code and a 128-bit token", () => {
    const reset = db.createPasswordReset(EMAIL);

    expect(reset.code).toMatch(/^\d{6}$/);
    expect(reset.token).toMatch(/^reset_[0-9a-f]{32}$/);
    // Two requests never share a token: a guessed token would be a takeover.
    const second = db.createPasswordReset("other@retroflex.app");
    expect(second.token).not.toBe(reset.token);
  });

  it("accepts the right code once", () => {
    const reset = db.createPasswordReset(EMAIL);

    const result = db.verifyPasswordReset(EMAIL, reset.code);
    expect(result.error).toBeNull();
    expect(result.reset?.verifiedAt).toBeTypeOf("number");
  });

  it("burns the request after five wrong codes, as the screen promises", () => {
    const reset = db.createPasswordReset(EMAIL);
    const wrong = String((Number(reset.code) + 1) % 1_000_000).padStart(6, "0");

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(db.verifyPasswordReset(EMAIL, wrong).error, `attempt ${attempt}`).toBe("Invalid or expired code");
    }
    expect(db.verifyPasswordReset(EMAIL, wrong).error).toMatch(/too many/i);
    // Even the correct code no longer works on this request.
    expect(db.verifyPasswordReset(EMAIL, reset.code).error).toMatch(/too many/i);
  });

  it("stores exactly what the caller hashed — never the submission", () => {
    const driver: Driver = {
      id: "drv_reset",
      name: "Reset",
      email: EMAIL,
      phone: "",
      password: "",
      city: "Sydney",
      pairCode: "7K2M9Q",
      createdAt: new Date().toISOString(),
      platforms: ["uber"],
      vehicle: { make: "", model: "", color: "", plate: "", year: "" },
      role: "driver",
    };
    db.saveDriver(driver);

    const reset = db.createPasswordReset(EMAIL);
    db.verifyPasswordReset(EMAIL, reset.code);
    const hash = "pbkdf2-sha256$210000$c2FsdA==$aGFzaA==";
    const updated = db.completePasswordReset(reset.token, hash);

    expect(updated?.password).toBe(hash);
    expect(db.findByEmail(EMAIL)?.password).toBe(hash);
    // Single use.
    expect(db.completePasswordReset(reset.token, hash)).toBeNull();
  });
});
