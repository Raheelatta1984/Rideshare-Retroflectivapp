import { beforeEach, describe, expect, it } from "vitest";
import { db, defaultSettings } from "./storage";
import type { ActivityLog } from "../types";

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
