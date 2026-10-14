import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ActivityLog,
  DisplaySettings,
  Driver,
  Ride,
  RideStatus,
  TerminalAccount,
  TerminalBinding,
  TerminalOrigin,
  TerminalPosition,
} from "./types";
import { db, defaultSettings } from "./lib/storage";
import { normalizePairCode, pairCode, uid } from "./lib/id";
import { DEMO_DRIVER, seedDefaultAdmins, seedDemoDriver } from "./lib/demo";
import { SAMPLE_RIDES } from "./lib/platforms";
import { isSourceOwner, resolvedRole, SOURCE_OWNER_EMAIL } from "./lib/access";
import { getBackend, toTerminalAccount } from "./lib/backend";
import type { AccountResult, PairCodeResolution } from "./lib/backend/types";
import { createDeviceProfile, deviceProfileId, normalizeDeviceProfile } from "./lib/devices";
import { parseTerminalRequest, readLocalBinding, terminalConsentKey, terminalDeviceId } from "./lib/terminals";

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
  /** Terminal sign-up flow — see TERMINAL-SIGNUP.md. Provider-agnostic. */
  terminalAccount: TerminalAccount | null;
  terminalBinding: TerminalBinding | null;
  /** Booth resolved from a pair code, with its display settings. No session. */
  terminalBooth: { account: TerminalAccount; settings: DisplaySettings } | null;
  signUpTerminal: (input: { name: string; email: string; password: string; phone?: string; city?: string }) => Promise<AccountResult>;
  signInTerminal: (input: { email: string; password: string }) => Promise<AccountResult>;
  resolveTerminalCode: (code: string) => Promise<PairCodeResolution>;
  assignTerminal: (input: {
    pairCode: string;
    position: TerminalPosition;
    deviceName: string;
    origin: TerminalOrigin;
    account?: TerminalAccount | null;
  }) => Promise<{ binding: TerminalBinding | null; error: string | null }>;
  releaseTerminal: () => Promise<void>;
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
  // Terminal sign-up state. `terminalAccount` is the account behind the scanned
  // flow; `terminalBooth` is a locally-known booth resolved from a pair code.
  // Neither creates a console session on the terminal — see assignTerminal.
  const [terminalAccount, setTerminalAccount] = useState<TerminalAccount | null>(null);
  const [terminalBinding, setTerminalBinding] = useState<TerminalBinding | null>(() => readLocalBinding());
  const [terminalBooth, setTerminalBooth] = useState<{ account: TerminalAccount; settings: DisplaySettings } | null>(null);

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

  // Refresh terminal state from the provider, but only on a device that is
  // actually acting as a terminal. A marketing visitor never gets a device id
  // minted and never triggers a registry round-trip.
  useEffect(() => {
    const request = parseTerminalRequest(
      typeof window === "undefined" ? "" : window.location.search,
      typeof window === "undefined" ? "" : window.location.hash,
    );
    const existing = readLocalBinding();
    if (!request.active && !existing) return;

    let cancelled = false;
    const deviceId = terminalDeviceId();

    // A binding that points at a booth stored in this browser carries its display
    // settings, so a reload goes straight back to the glass without re-assigning.
    if (existing?.accountId) {
      const booth = db.findById(existing.accountId);
      if (booth) {
        setTerminalBooth({ account: toTerminalAccount(booth), settings: db.getSettings(booth.id) });
      }
    }

    void getBackend()
      .terminals.find(deviceId)
      .then((binding) => {
        if (!cancelled && binding) setTerminalBinding(binding);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
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

  /* ------------------------------------------------------------------ *
   * Terminal sign-up — scan the QR, log in or sign up, assign, display.
   *
   * Everything here goes through the provider-agnostic backend, so the same
   * flow runs on the on-device adapter today and on Supabase the moment
   * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are set.
   * ------------------------------------------------------------------ */

  const adoptAccount = (account: TerminalAccount | null) => {
    if (!account) return;
    setTerminalAccount(account);
    // The local adapter's account IS a booth record in this browser. Loading it
    // as the terminal's booth gives the display real settings — without writing
    // a session, so the driver console stays locked on the terminal.
    const booth = db.findById(account.id);
    if (booth) setTerminalBooth({ account: toTerminalAccount(booth), settings: db.getSettings(booth.id) });
  };

  const signUpTerminal = async (input: { name: string; email: string; password: string; phone?: string; city?: string }): Promise<AccountResult> => {
    const result = await getBackend().accounts.signUp(input);
    if (result.error || !result.account) return result;
    adoptAccount(result.account);
    return result;
  };

  const signInTerminal = async (input: { email: string; password: string }): Promise<AccountResult> => {
    const result = await getBackend().accounts.signIn(input);
    if (result.error || !result.account) return result;
    adoptAccount(result.account);
    return result;
  };

  const resolveTerminalCode = async (code: string): Promise<PairCodeResolution> => {
    const resolution = await getBackend().accounts.resolvePairCode(code);
    if (resolution.account) adoptAccount(resolution.account);
    return resolution;
  };

  const assignTerminal = async (input: {
    pairCode: string;
    position: TerminalPosition;
    deviceName: string;
    origin: TerminalOrigin;
    account?: TerminalAccount | null;
  }): Promise<{ binding: TerminalBinding | null; error: string | null }> => {
    const code = normalizePairCode(input.pairCode);
    if (code.length !== 6) return { binding: null, error: "A pair code is six characters." };

    const deviceId = terminalDeviceId();
    const owner = input.account ?? terminalAccount ?? terminalBooth?.account ?? null;
    const position = input.position === "front" ? "front" : "rear";

    try {
      const binding = await getBackend().terminals.bind({
        deviceId,
        deviceName: input.deviceName,
        pairCode: code,
        position,
        accountId: owner?.id ?? null,
        accountEmail: owner?.email || undefined,
        origin: input.origin,
      });

      // Assigning IS the authorization: the person holding the terminal just
      // confirmed it, so the separate "I authorize display control" gate must
      // not ask again on every reload.
      localStorage.setItem(terminalConsentKey(position, code), "yes");
      setTerminalBinding(binding);

      db.addTabletActivity({
        id: uid("tablog"),
        at: Date.now(),
        pairCode: code,
        deviceId,
        action: "Terminal assigned",
        details: { position, deviceName: input.deviceName, origin: input.origin, account: owner?.email ?? "no account" },
      });

      /* Booth-side bookkeeping.
       *
       * Three cases, in order of how much this device knows:
       *   1. the console session owns the code  → update live store settings
       *   2. a booth was resolved during this flow → update its stored settings
       *   3. only an account id (shared backend)  → keep a local settings mirror
       * In cases 2 and 3 the terminal holds no session, so the driver console
       * stays locked on the tablet while the glass still follows its owner.
       */
      const codeOf = (pair: string | undefined, front: string | undefined) => normalizePairCode(position === "front" ? front : pair);
      const ownsCode = (candidate: TerminalAccount | null | undefined) =>
        !!candidate && (normalizePairCode(candidate.pairCode) === code || normalizePairCode(candidate.frontPairCode) === code);

      const sessionOwns = !!driver && codeOf(driver.pairCode, driver.frontPairCode) === code;
      // Only ever write into a booth that actually owns the assigned code, so a
      // mistyped code cannot attach a terminal to somebody else's settings.
      const resolvedAccount = sessionOwns ? null : ownsCode(terminalBooth?.account) ? terminalBooth?.account ?? null : ownsCode(owner) ? owner : null;
      const accountId = sessionOwns ? driver?.id ?? null : resolvedAccount?.id ?? null;

      if (accountId) {
        const base = sessionOwns ? settings : terminalBooth && terminalBooth.account.id === accountId ? terminalBooth.settings : db.getSettings(accountId);
        const profile = createDeviceProfile({
          id: deviceProfileId(deviceId, position),
          deviceId,
          pairCode: code,
          position,
          label: input.deviceName,
          apps: base.apps ?? [],
        });
        const deviceProfiles = [
          ...(base.deviceProfiles ?? []).map(normalizeDeviceProfile).filter((item) => item.id !== profile.id),
          profile,
        ];
        // A terminal that just created its own booth has no phone paired yet, so
        // light the beacon — otherwise the driver signs up and stares at a black
        // screen. Joining an existing booth leaves the driver switch exactly
        // where its owner set it; the phone stays the authority either way.
        const masterOn = input.origin === "signup" ? true : base.masterOn;
        const nextSettings = { ...base, deviceProfiles, masterOn };
        db.saveSettings(accountId, nextSettings);

        if (sessionOwns) {
          setSettings(nextSettings);
          if (input.origin === "signup") setPoweredState(true);
          recordActivity({
            action: "Terminal assigned",
            pairCode: code,
            deviceId,
            deviceName: input.deviceName,
            details: { position, origin: input.origin },
          });
        } else {
          if (resolvedAccount) setTerminalBooth({ account: resolvedAccount, settings: nextSettings });
        }
      }

      return { binding, error: null };
    } catch (error) {
      return { binding: null, error: error instanceof Error ? error.message : "Could not assign this terminal." };
    }
  };

  const releaseTerminal = async () => {
    const binding = terminalBinding ?? readLocalBinding();
    if (binding) {
      await getBackend().terminals.unbind(binding.id).catch(() => undefined);
      localStorage.removeItem(terminalConsentKey(binding.position, binding.pairCode));
      db.addTabletActivity({
        id: uid("tablog"),
        at: Date.now(),
        pairCode: binding.pairCode,
        deviceId: binding.deviceId,
        action: "Terminal released",
        details: { position: binding.position },
      });
    }
    setTerminalBinding(null);
    setTerminalBooth(null);
    setTerminalAccount(null);
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
    terminalAccount,
    terminalBinding,
    terminalBooth,
    signUpTerminal,
    signInTerminal,
    resolveTerminalCode,
    assignTerminal,
    releaseTerminal,
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
