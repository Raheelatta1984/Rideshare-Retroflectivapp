import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ActivityLog, DisplaySettings, Driver, Ride, RideStatus } from "./types";
import { db, defaultSettings } from "./lib/storage";
import { pairCode, uid } from "./lib/id";
import { DEMO_DRIVER, seedDefaultAdmins, seedDemoDriver } from "./lib/demo";
import { SAMPLE_RIDES } from "./lib/platforms";
import { isSourceOwner, resolvedRole, SOURCE_OWNER_EMAIL } from "./lib/access";

interface Store {
  ready: boolean;
  driver: Driver | null;
  rides: Ride[];
  logs: ActivityLog[];
  activeRide: Ride | null;
  powered: boolean;
  settings: DisplaySettings;
  setPowered: (on: boolean) => void;
  bootDemo: () => void;
  login: (email: string, password: string) => string | null;
  requestPasswordReset: (email: string) => { error: string | null; recipient: string | null; emailHref: string | null };
  verifyPasswordResetCode: (email: string, code: string) => { error: string | null; token: string | null };
  validatePasswordReset: (token: string) => { email: string } | null;
  resetPassword: (token: string, password: string) => string | null;
  signup: (input: { name: string; email: string; password: string; phone: string; city: string }) => string | null;
  logout: () => void;
  updateDriver: (patch: Partial<Driver>) => void;
  updateVehicle: (patch: Partial<Driver["vehicle"]>) => void;
  saveSettings: (patch: Partial<DisplaySettings>) => void;
  pushRide: (partial: Partial<Ride> & Pick<Ride, "platform" | "passengerFirst">) => Ride;
  setStatus: (status: RideStatus) => void;
  clearRide: () => void;
  rotatePair: () => string;
  rotateFrontPair: () => string;
  recordActivity: (entry: Omit<ActivityLog, "id" | "at" | "actorId">) => void;
}

const Ctx = createContext<Store | null>(null);

function withFrontPair(driver: Driver): Driver {
  return driver.frontPairCode ? driver : { ...driver, frontPairCode: pairCode() };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [driver, setDriver] = useState<Driver | null>(null);
  const [rides, setRides] = useState<Ride[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [powered, setPoweredState] = useState(false);
  const [settings, setSettings] = useState<DisplaySettings>(defaultSettings());

  useEffect(() => {
    const legacyDemo = db.findByEmail(DEMO_DRIVER.email);
    // One-time upgrade from the earlier demo profile. Subsequent edits stay in local browser storage.
    if (legacyDemo?.name === "Alex Rivera" && legacyDemo.vehicle.make === "Tesla") {
      db.saveDriver({
        ...legacyDemo,
        name: DEMO_DRIVER.name,
        phone: DEMO_DRIVER.phone,
        vehicle: DEMO_DRIVER.vehicle,
        platforms: DEMO_DRIVER.platforms,
        role: "admin",
      });
    }
    seedDemoDriver(db.saveDriver, db.findByEmail);
    seedDefaultAdmins(db.saveDriver, db.findByEmail);
    const session = db.getSession();
    if (session) {
      const d = db.findById(session.driverId);
      if (d) {
        const normalized = withFrontPair({ ...d, role: resolvedRole(d.email, d.role) });
        if (d.role !== normalized.role || !d.frontPairCode) db.saveDriver(normalized);
        const savedSettings = db.getSettings(normalized.id);
        setDriver(normalized);
        setRides(db.listRides(normalized.id));
        setLogs(db.listActivity(normalized.id));
        setSettings(savedSettings);
        setPoweredState(savedSettings.masterOn ?? false);
      }
    }
    setReady(true);
  }, []);

  const hydrate = (d: Driver) => {
    const normalized = withFrontPair({ ...d, role: resolvedRole(d.email, d.role) });
    if (d.role !== normalized.role || !d.frontPairCode) db.saveDriver(normalized);
    const savedSettings = db.getSettings(normalized.id);
    db.setSession({ driverId: normalized.id });
    setDriver(normalized);
    setRides(db.listRides(normalized.id));
    setLogs(db.listActivity(normalized.id));
    setSettings(savedSettings);
    setPoweredState(savedSettings.masterOn ?? false);
  };

  const bootDemo = () => {
    seedDemoDriver(db.saveDriver, db.findByEmail);
    seedDefaultAdmins(db.saveDriver, db.findByEmail);
    const d = db.findByEmail(DEMO_DRIVER.email) ?? DEMO_DRIVER;
    if (!db.findByEmail(DEMO_DRIVER.email)) db.saveDriver(DEMO_DRIVER);
    hydrate(d);
  };

  const persistDriver = (d: Driver) => {
    db.saveDriver(d);
    setDriver(d);
  };

  const login = (email: string, password: string) => {
    const found = db.findByEmail(email);
    if (!found || found.password !== password) return "Email or password is wrong.";
    hydrate(found);
    return null;
  };

  const requestPasswordReset = (email: string) => {
    let reset = db.createPasswordReset(email);

    // First-time owner activation: create only the local admin record with an
    // empty password. It cannot be used until the one-time reset token is verified.
    if (!reset && isSourceOwner(email)) {
      const owner: Driver = {
        id: uid("drv"),
        name: "Raheel Atta",
        email: SOURCE_OWNER_EMAIL,
        phone: "",
        password: "",
        city: "",
        pairCode: pairCode(),
        frontPairCode: pairCode(),
        createdAt: new Date().toISOString(),
        platforms: ["didi"],
        vehicle: { make: "Toyota", model: "Prius V", color: "Snow White", plate: "CIW37G", year: "" },
        role: "admin",
      };
      db.saveDriver(owner);
      db.saveSettings(owner.id, defaultSettings());
      reset = db.createPasswordReset(SOURCE_OWNER_EMAIL);
    }

    if (!reset) {
      return { error: "No local Retroflex account was found for that email. Create an account first, then use email recovery.", recipient: null, emailHref: null };
    }
    const subject = "Retroflex password reset verification code";
    const body = `Your Retroflex password reset code is:\n\n${reset.code}\n\nEnter this 6-digit code in the Retroflex app within 30 minutes. Do not share this code with anyone.`;
    return {
      error: null,
      recipient: reset.email,
      emailHref: `mailto:${encodeURIComponent(reset.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    };
  };

  const verifyPasswordResetCode = (email: string, code: string) => {
    const result = db.verifyPasswordReset(email, code);
    return { error: result.error, token: result.reset?.token ?? null };
  };

  const validatePasswordReset = (token: string) => {
    const reset = db.getPasswordReset(token);
    return reset?.verifiedAt ? { email: reset.email } : null;
  };

  const resetPassword = (token: string, password: string) => {
    if (password.length < 8) return "Use at least 8 characters.";
    const account = db.completePasswordReset(token, password);
    return account ? null : "This reset link is invalid, expired, or no longer matches a local account.";
  };

  const signup = (input: { name: string; email: string; password: string; phone: string; city: string }) => {
    if (db.findByEmail(input.email)) return "An account already exists for that email.";
    const d: Driver = {
      id: uid("drv"),
      name: input.name,
      email: input.email,
      phone: input.phone,
      password: input.password,
      city: input.city,
      pairCode: pairCode(),
      createdAt: new Date().toISOString(),
      platforms: ["uber", "didi"],
      vehicle: { make: "", model: "", color: "", plate: "", year: "" },
      role: isSourceOwner(input.email) ? "admin" : "driver",
    };
    db.saveDriver(d);
    db.setSession({ driverId: d.id });
    setDriver(d);
    setRides([]);
    setLogs([]);
    const freshSettings = defaultSettings();
    setSettings(freshSettings);
    setPoweredState(false);
    db.saveSettings(d.id, freshSettings);
    return null;
  };

  const logout = () => {
    db.setSession(null);
    setDriver(null);
    setRides([]);
    setLogs([]);
    setPoweredState(false);
  };

  const recordActivity = (entry: Omit<ActivityLog, "id" | "at" | "actorId">) => {
    if (!driver) return;
    const full: ActivityLog = {
      id: uid("log"),
      at: Date.now(),
      actorId: driver.id,
      ...entry,
    };
    db.addActivity(full);
    setLogs((items) => [full, ...items].slice(0, 500));
  };

  const updateDriver = (patch: Partial<Driver>) => {
    if (!driver) return;
    const nextDriver = { ...driver, ...patch };
    persistDriver(nextDriver);
    // App choices drive the rear display. Keep settings in sync with the driver console.
    if (patch.platforms) {
      const nextSettings = { ...settings, apps: patch.platforms };
      setSettings(nextSettings);
      db.saveSettings(driver.id, nextSettings);
      recordActivity({ action: "Platforms updated", pairCode: driver.pairCode, platforms: patch.platforms, details: { count: patch.platforms.length } });
    }
  };

  const updateVehicle = (patch: Partial<Driver["vehicle"]>) => {
    if (!driver) return;
    persistDriver({ ...driver, vehicle: { ...driver.vehicle, ...patch } });
    recordActivity({ action: "Vehicle profile updated", pairCode: driver.pairCode, details: { ...patch } });
  };

  const setPowered = (on: boolean) => {
    setPoweredState(on);
    // Keep masterOn in sync so the tablet (which reads settings.masterOn) flips instantly.
    setSettings((current) => {
      const next = { ...current, masterOn: on };
      if (driver) db.saveSettings(driver.id, next);
      return next;
    });
    recordActivity({ action: on ? "Central display ON" : "Central display OFF", pairCode: driver?.pairCode });
  };

  const saveSettings = (patch: Partial<DisplaySettings>) => {
    if (!driver) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    db.saveSettings(driver.id, next);
  };

  const pushRide = (partial: Partial<Ride> & Pick<Ride, "platform" | "passengerFirst">) => {
    if (!driver) throw new Error("Not signed in");
    const sample = SAMPLE_RIDES[Math.floor(Math.random() * SAMPLE_RIDES.length)];
    const ride: Ride = {
      id: uid("ride"),
      driverId: driver.id,
      platform: partial.platform,
      passengerFirst: partial.passengerFirst,
      passengerLastInitial: (partial.passengerLastInitial ?? sample.passengerLastInitial).slice(0, 1).toUpperCase(),
      colorCode: partial.colorCode ?? sample.colorCode,
      pin: partial.pin ?? String(Math.floor(1000 + Math.random() * 9000)),
      pickup: partial.pickup ?? sample.pickup,
      dropoff: partial.dropoff ?? sample.dropoff,
      fare: partial.fare ?? sample.fare,
      etaMinutes: partial.etaMinutes ?? sample.etaMinutes,
      status: partial.status ?? "incoming",
      createdAt: new Date().toISOString(),
    };
    db.upsertRide(ride);
    setRides((r) => [ride, ...r.filter((x) => x.id !== ride.id)]);
    return ride;
  };

  const setStatus = (status: RideStatus) => {
    const active = rides.find((r) => !["complete", "idle"].includes(r.status));
    if (!active) return;
    const next: Ride = {
      ...active,
      status,
      acceptedAt: status === "accepted" || status === "en_route" ? active.acceptedAt ?? new Date().toISOString() : active.acceptedAt,
      stoppedAt: status === "stopped" ? active.stoppedAt ?? new Date().toISOString() : active.stoppedAt,
      arrivedAt: status === "arrived" ? active.arrivedAt ?? new Date().toISOString() : active.arrivedAt,
      completedAt: status === "complete" ? new Date().toISOString() : active.completedAt,
    };
    db.upsertRide(next);
    setRides((r) => r.map((x) => (x.id === next.id ? next : x)));
  };

  const clearRide = () => {
    const active = rides.find((r) => !["complete", "idle"].includes(r.status));
    if (!active) return;
    const next = { ...active, status: "complete" as const, completedAt: new Date().toISOString() };
    db.upsertRide(next);
    setRides((r) => r.map((x) => (x.id === next.id ? next : x)));
  };

  const rotatePair = () => {
    const next = pairCode();
    if (driver) persistDriver({ ...driver, pairCode: next });
    return next;
  };

  const rotateFrontPair = () => {
    const next = pairCode();
    if (driver) persistDriver({ ...driver, frontPairCode: next });
    return next;
  };

  const activeRide = useMemo(
    () => rides.find((r) => !["complete", "idle"].includes(r.status)) ?? null,
    [rides],
  );

  const value: Store = {
    ready,
    driver,
    rides,
    logs,
    activeRide,
    powered,
    settings,
    setPowered,
    bootDemo,
    login,
    requestPasswordReset,
    verifyPasswordResetCode,
    validatePasswordReset,
    resetPassword,
    signup,
    logout,
    updateDriver,
    updateVehicle,
    saveSettings,
    pushRide,
    setStatus,
    clearRide,
    rotatePair,
    rotateFrontPair,
    recordActivity,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("Store missing");
  return ctx;
}

export function useOptionalStore() {
  return useContext(Ctx);
}

export { DEMO_DRIVER };
