import { useEffect, useMemo, useRef, useState } from "react";
import {
  BatteryCharging,
  Bell,
  Car,
  History,
  LogOut,
  Power,
  Radio,
  Settings,
  Smartphone,
  Tablet,
} from "lucide-react";
import { useStore } from "../store";
import { PLATFORMS, getPlatform } from "../lib/platforms";
import { formatPair } from "../lib/id";
import { useFleetChannels } from "../lib/sync";
import { kph, useMotion } from "../lib/motion";
import { Check } from "lucide-react";
import type { CommercialCampaign, CommercialCampaignLegal, ConsentRole, DeviceProfile, DeviceTelemetry, DisplaySettings, DriverRole, LegalConsent, TabletBattery, TabletDevice } from "../types";
import { codeProfileId, createDeviceProfile, deviceProfileId, profileForDevice } from "../lib/devices";
import { canDownloadSource, isSourceOwner, SOURCE_OWNER_EMAIL } from "../lib/access";
import { createConsentPdf, deliverAgreementPdf } from "../lib/agreements";
import { Logo } from "./Logo";
import { DisplayScreen } from "./DisplayScreen";
import { useNow } from "../hooks";

type Tab = "live" | "display" | "history" | "settings";

function masterForPosition(position: "rear" | "front", settings: DisplaySettings) {
  return position === "front" ? (settings.frontMasterOn ?? true) : (settings.rearMasterOn ?? true);
}

export function DriverConsole({ go }: { go: (p: string) => void }) {
  const store = useStore();
  const { driver, powered, setPowered, settings, saveSettings, rides, logs, activeRide, clearRide, updateDriver, recordActivity } = store;
  const [tab, setTab] = useState<Tab>("live");
  const [motionOverride, setMotionOverride] = useState<boolean | undefined>(undefined);
  const [tabletBattery, setTabletBattery] = useState<TabletBattery | null>(null);
  const [deviceBatteries, setDeviceBatteries] = useState<Record<string, TabletBattery>>({});
  const [connectedDevices, setConnectedDevices] = useState<Record<string, TabletDevice>>({});
  const [deviceTelemetry, setDeviceTelemetry] = useState<Record<string, DeviceTelemetry>>({});
  const [batteryAlert, setBatteryAlert] = useState<string | null>(null);
  const lastBatteryBucket = useRef<number | null>(null);
  const lastBatteryAlertAt = useRef(0);
  const alertTimer = useRef<number | null>(null);
  const lastTelemetryLog = useRef<Record<string, { at: number; state: string }>>({});
  const now = useNow(1000);
  const motionGate = settings.motionSafetyGate ?? true;
  const driverMotion = useMotion(powered && motionGate, motionOverride, settings.stationarySpeedKph ?? 0.5);
  const driverMotionRef = useRef(driverMotion);
  driverMotionRef.current = driverMotion;

  const rearPrimaryProfile = driver ? createDeviceProfile({
    id: codeProfileId(driver.pairCode, "rear"),
    pairCode: driver.pairCode,
    position: "rear",
    label: `Rear pair ${driver.pairCode}`,
    powered: true,
    apps: driver.platforms,
  }) : null;
  const frontPrimaryProfile = driver?.frontPairCode ? createDeviceProfile({
    id: codeProfileId(driver.frontPairCode, "front"),
    pairCode: driver.frontPairCode,
    position: "front",
    label: `Front pair ${driver.frontPairCode}`,
    powered: true,
    apps: driver.platforms,
    passengerNameEnabled: false,
  }) : null;
  const deviceProfiles = useMemo(() => {
    const saved = settings.deviceProfiles ?? [];
    const defaults = [rearPrimaryProfile, frontPrimaryProfile].filter(Boolean) as DeviceProfile[];
    return [...defaults.filter((profile) => !saved.some((item) => item.id === profile.id)), ...saved];
  }, [settings.deviceProfiles, rearPrimaryProfile?.id, frontPrimaryProfile?.id, driver?.platforms, driver?.pairCode, driver?.frontPairCode]);
  const pairCodes = useMemo(() => [...new Set(deviceProfiles.map((profile) => profile.pairCode))], [deviceProfiles]);

  const upsertProfile = (profile: DeviceProfile) => {
    const exists = deviceProfiles.some((item) => item.id === profile.id);
    const next = exists ? deviceProfiles.map((item) => (item.id === profile.id ? profile : item)) : [...deviceProfiles, profile];
    saveSettings({ deviceProfiles: next });
    recordActivity({
      action: "Device profile updated",
      pairCode: profile.pairCode,
      deviceId: profile.deviceId,
      deviceName: profile.label,
      platforms: profile.apps,
      details: {
        powered: profile.powered,
        logoSeconds: profile.displayDurationSeconds,
        blankBetween: profile.includeBlank,
        blankSeconds: profile.blankDurationSeconds,
        brightness: profile.brightness,
        adaptiveBrightness: profile.adaptiveBrightness,
      },
    });
    if (driver && profile.id === codeProfileId(driver.pairCode, "rear")) updateDriver({ platforms: profile.apps });
  };

  const receiveBattery = (battery: TabletBattery) => {
    setTabletBattery(battery);
    const id = battery.deviceId ?? "current-tablet";
    setDeviceBatteries((devices) => ({ ...devices, [id]: battery }));
    if (battery.deviceId) {
      setConnectedDevices((devices) => ({
        ...devices,
        [battery.deviceId!]: {
          id: battery.deviceId!,
          name: battery.deviceName ?? devices[battery.deviceId!]?.name ?? "Rear tablet",
          pairCode: battery.pairCode ?? devices[battery.deviceId!]?.pairCode ?? driver?.pairCode ?? "",
          position: battery.position ?? devices[battery.deviceId!]?.position ?? "rear",
          lastSeen: battery.updatedAt,
        },
      }));
    }
    const step = settings.batteryAlertStep ?? 1;
    const nextBucket = Math.floor(battery.percentage / step) * step;
    const previousBucket = lastBatteryBucket.current;
    lastBatteryBucket.current = nextBucket;
    if (previousBucket == null || previousBucket === nextBucket) return;
    // Monitor continuously, but suppress alerts at the full and critical endpoints.
    if (!settings.batteryAlertsEnabled || battery.percentage <= 5 || battery.percentage >= 100) return;
    const cooldown = (settings.batteryAlertCooldownMinutes ?? 1) * 60_000;
    if (Date.now() - lastBatteryAlertAt.current < cooldown) return;
    lastBatteryAlertAt.current = Date.now();

    const direction = nextBucket > previousBucket ? "increased" : "dropped";
    const message = `Rear tablet battery ${direction} to ${battery.percentage}%${battery.charging ? " · charging" : ""}`;
    setBatteryAlert(message);
    if (alertTimer.current) window.clearTimeout(alertTimer.current);
    alertTimer.current = window.setTimeout(() => setBatteryAlert(null), 6500);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Retroflex rear tablet", { body: message });
    }
  };

  const { publishTo, publishAll, connectedCodes } = useFleetChannels(pairCodes, (packet, pairCode) => {
    if (packet.type === "battery" && packet.battery) receiveBattery({ ...packet.battery, pairCode });
    if (packet.type === "activity" && packet.activity) {
      const activity = packet.activity;
      recordActivity({
        action: activity.action,
        pairCode,
        deviceId: activity.deviceId,
        deviceName: connectedDevices[activity.deviceId]?.name ?? "Rear tablet",
        details: activity.details,
      });
    }
    if (packet.type === "telemetry" && packet.telemetry) {
      const telemetry = { ...packet.telemetry, pairCode, at: packet.telemetry.at || Date.now() };
      setDeviceTelemetry((items) => ({ ...items, [telemetry.deviceId]: telemetry }));
      setConnectedDevices((devices) => ({ ...devices, [telemetry.deviceId]: { id: telemetry.deviceId, name: telemetry.deviceName, pairCode, position: telemetry.position, lastSeen: telemetry.at } }));
      const previous = lastTelemetryLog.current[telemetry.deviceId];
      if (!previous || previous.state !== telemetry.displayState || telemetry.at - previous.at >= 60_000) {
        lastTelemetryLog.current[telemetry.deviceId] = { at: telemetry.at, state: telemetry.displayState };
        recordActivity({
          action: "Remote telemetry",
          pairCode,
          deviceId: telemetry.deviceId,
          deviceName: telemetry.deviceName,
          details: { state: telemetry.displayState, content: telemetry.activeContent, battery: telemetry.battery?.percentage, screen: telemetry.screen, network: telemetry.connection, memoryGb: telemetry.deviceMemoryGb, heapMb: telemetry.jsHeapUsedMb },
        });
      }
    }
    if (packet.type === "hello" && packet.device) {
      const device = { ...packet.device, pairCode, lastSeen: Date.now() };
      setConnectedDevices((devices) => ({ ...devices, [device.id]: device }));
      if (!connectedDevices[device.id]) {
        recordActivity({ action: "Tablet connected", pairCode, deviceId: device.id, deviceName: device.name });
      }
      if (!deviceProfiles.some((profile) => profile.deviceId === device.id)) {
        const source = profileForDevice(deviceProfiles, undefined, pairCode, device.position);
        upsertProfile(createDeviceProfile({ ...source, id: deviceProfileId(device.id, device.position), deviceId: device.id, pairCode, position: device.position, label: `${device.position === "front" ? "Front" : "Rear"} · ${device.name}` }));
      }
    }
  });

  useEffect(() => () => {
    if (alertTimer.current) window.clearTimeout(alertTimer.current);
  }, []);

  // Broadcast power + settings so the paired tablet mirrors this control.
  useEffect(() => {
    if (!driver) return;
    publishAll((pairCode) => {
      const profile = deviceProfiles.find((item) => item.pairCode === pairCode && !item.deviceId) ?? createDeviceProfile({ pairCode });
      return {
        type: "settings",
        settings: {
          ...settings,
          deviceProfiles,
          masterOn: powered && masterForPosition(profile.position, settings) && profile.powered,
          apps: profile.apps,
          displayDurationSeconds: profile.displayDurationSeconds,
          includeBlank: profile.includeBlank,
          blankDurationSeconds: profile.blankDurationSeconds,
          brightness: profile.brightness,
          adaptiveBrightness: profile.adaptiveBrightness,
        },
        motion: driverMotion,
        ride: activeRide,
      };
    });
  }, [powered, settings, activeRide, deviceProfiles, driver?.id]);

  useEffect(() => {
    if (!driver) return;
    Object.values(connectedDevices).forEach((device) => {
      const profile =
        profileForDevice(deviceProfiles, device, device.pairCode, device.position) ??
        createDeviceProfile({
          id: deviceProfileId(device.id, device.position),
          pairCode: device.pairCode,
          position: device.position,
          deviceId: device.id,
          label: device.name,
          apps: settings.apps ?? [],
        });
      publishTo(device.pairCode, {
        type: "settings",
        targetDeviceId: device.id,
        settings: {
          ...settings,
          deviceProfiles,
          masterOn: powered && masterForPosition(profile.position, settings) && profile.powered,
          apps: profile.apps,
          displayDurationSeconds: profile.displayDurationSeconds,
          includeBlank: profile.includeBlank,
          blankDurationSeconds: profile.blankDurationSeconds,
          brightness: profile.brightness,
          adaptiveBrightness: profile.adaptiveBrightness,
        },
        motion: driverMotion,
        ride: activeRide,
      });
    });
  }, [connectedDevices, deviceProfiles, powered, settings, activeRide, driver?.id]);

  // Driver motion is published independently of display settings. A moving
  // heartbeat is delivered at most once per second so remote displays blank
  // promptly without flooding mobile data or heating the tablet.
  const pairCodeKey = pairCodes.join("|");
  useEffect(() => {
    if (!driver || !motionGate) return;
    const sendMotion = () => {
      publishAll(() => ({ type: "motion", motion: driverMotionRef.current }));
    };
    sendMotion();
    const id = window.setInterval(sendMotion, 1000);
    return () => window.clearInterval(id);
  }, [driver?.id, motionGate, pairCodeKey]);

  useEffect(() => {
    if (!driver || !motionGate || driverMotion.isStationary) return;
    // Do not wait for the one-second cadence when movement is detected.
    publishAll(() => ({ type: "motion", motion: driverMotion }));
  }, [driver?.id, motionGate, pairCodeKey, driverMotion.isStationary, driverMotion.allowed]);

  // Low-frequency heartbeat restores the current state after mobile-network pauses.
  useEffect(() => {
    if (!driver) return;
    const heartbeat = () => {
      publishAll((pairCode) => {
        const profile = deviceProfiles.find((item) => item.pairCode === pairCode && !item.deviceId) ?? createDeviceProfile({ pairCode });
        return {
          type: "settings",
          settings: { ...settings, deviceProfiles, masterOn: powered && masterForPosition(profile.position, settings) && profile.powered, apps: profile.apps, displayDurationSeconds: profile.displayDurationSeconds, includeBlank: profile.includeBlank, blankDurationSeconds: profile.blankDurationSeconds, brightness: profile.brightness, adaptiveBrightness: profile.adaptiveBrightness },
          motion: driverMotion,
          ride: activeRide,
        };
      });
      Object.values(connectedDevices).forEach((device) => {
        const profile =
        profileForDevice(deviceProfiles, device, device.pairCode, device.position) ??
        createDeviceProfile({
          id: deviceProfileId(device.id, device.position),
          pairCode: device.pairCode,
          position: device.position,
          deviceId: device.id,
          label: device.name,
          apps: settings.apps ?? [],
        });
        publishTo(device.pairCode, {
          type: "settings",
          targetDeviceId: device.id,
          settings: { ...settings, deviceProfiles, masterOn: powered && masterForPosition(profile.position, settings) && profile.powered, apps: profile.apps, displayDurationSeconds: profile.displayDurationSeconds, includeBlank: profile.includeBlank, blankDurationSeconds: profile.blankDurationSeconds, brightness: profile.brightness, adaptiveBrightness: profile.adaptiveBrightness },
          motion: driverMotion,
          ride: activeRide,
        });
      });
    };
    const id = window.setInterval(heartbeat, 4_000);
    return () => window.clearInterval(id);
  }, [driver?.id, deviceProfiles, connectedDevices, powered, settings, activeRide]);

  // Turning power OFF clears any active ride so the tablet goes idle.
  useEffect(() => {
    if (!powered && activeRide) clearRide();
  }, [powered, activeRide, clearRide]);

  if (!driver) {
    return (
      <div className="grid min-h-dvh place-items-center bg-ink">
        <button onClick={() => go("/login")} className="rounded-full bg-amber px-6 py-3 text-ink">
          Sign in to drive
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-ink text-cream shadow-[0_0_0_1px_#232326]">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <Logo />
        <button onClick={() => { store.logout(); go("/"); }} className="text-mist hover:text-cream">
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto hide-scroll pb-24">
        {tab === "live" && <LiveTab powered={powered} setPowered={setPowered} motion={driverMotion} motionOverride={motionOverride} setMotionOverride={setMotionOverride} battery={tabletBattery} devices={Object.values(deviceBatteries)} telemetry={deviceTelemetry} now={now} settings={settings} profiles={deviceProfiles} onProfileChange={upsertProfile} alert={batteryAlert} role={driver?.role ?? "driver"} />}
        {tab === "display" && <DisplayTab connectedCodes={connectedCodes} />}
        {tab === "history" && <HistoryTab rides={rides} logs={logs} role={driver?.role ?? "driver"} />}
        {tab === "settings" && <SettingsTab />}
      </main>

      <nav className="fixed bottom-0 left-1/2 z-20 flex w-full max-w-md -translate-x-1/2 border-t border-line bg-ink/95 px-2 py-2 backdrop-blur">
        {(
          [
            ["live", Radio, "Live"],
            ["display", Tablet, "Glass"],
            ["history", History, "Log"],
            ["settings", Settings, "Booth"],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex flex-1 flex-col items-center gap-1 py-2 text-[10px] tracking-widest uppercase ${tab === id ? "text-amber" : "text-mist"}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function LiveTab({
  powered,
  setPowered,
  motion,
  motionOverride,
  setMotionOverride,
  battery,
  devices,
  telemetry,
  now,
  settings,
  profiles,
  onProfileChange,
  alert,
  role,
}: {
  powered: boolean;
  setPowered: (on: boolean) => void;
  motion: import("../types").MotionState;
  motionOverride: boolean | undefined;
  setMotionOverride: (value: boolean | undefined) => void;
  battery: TabletBattery | null;
  devices: TabletBattery[];
  telemetry: Record<string, DeviceTelemetry>;
  now: number;
  settings: DisplaySettings;
  profiles: DeviceProfile[];
  onProfileChange: (profile: DeviceProfile) => void;
  alert: string | null;
  role: DriverRole;
}) {
  const { driver, saveSettings } = useStore();
  const allowCommercial = isSourceOwner(driver?.email);
  const rearPrimary = profiles.find((profile) => profile.pairCode === driver?.pairCode && profile.position === "rear" && !profile.deviceId) ?? (driver ? createDeviceProfile({ pairCode: driver.pairCode, position: "rear", apps: driver.platforms }) : null);
  const frontPrimary = profiles.find((profile) => profile.pairCode === driver?.frontPairCode && profile.position === "front" && !profile.deviceId) ?? (driver?.frontPairCode ? createDeviceProfile({ pairCode: driver.frontPairCode, position: "front", apps: driver.platforms, label: `Front pair ${driver.frontPairCode}` }) : null);
  // Keep profiles after a tablet disconnects so the next connection restores its last local setup.
  const controls = profiles;
  const [mirrorProfileId, setMirrorProfileId] = useState<string | null>(null);
  const mirrorProfile = controls.find((profile) => profile.id === mirrorProfileId) ?? null;
  const mirrorTelemetry = mirrorProfile?.deviceId
    ? telemetry[mirrorProfile.deviceId]
    : mirrorProfile
      ? Object.values(telemetry).find((item) => item.pairCode === mirrorProfile.pairCode)
      : undefined;

  const togglePower = () => {
    if (!powered && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    setPowered(!powered);
  };
  const stationaryWait = settings.stationaryWaitSeconds ?? 60;
  const motionGate = settings.motionSafetyGate ?? true;
  const secondsLeft = Math.max(0, stationaryWait - Math.floor(motion.stoppedForMs / 1000));
  const safeToDisplay = !motionGate || (motion.allowed && motion.isStationary && motion.stoppedForMs >= stationaryWait * 1000);

  const activateDisplays = (scope: "rear" | "front" | "both") => {
    setPowered(true);
    saveSettings({ rearMasterOn: scope === "rear" || scope === "both", frontMasterOn: scope === "front" || scope === "both" });
  };

  return (
    <div className="px-5 py-6">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[11px] tracking-[0.3em] text-mist">{powered ? "REAR GLASS · LIVE" : "REAR GLASS · IDLE"}</p>
          <h1 className="font-display text-3xl">{driver?.name.split(" ")[0]}</h1>
        </div>
        <div className="text-right text-xs text-mist">
          <div className="font-cond text-lg tracking-wider text-cream">{driver?.vehicle.plate || "NO PLATE"}</div>
          {driver?.vehicle.make} {driver?.vehicle.model}
        </div>
      </div>

      {/* Master power switch */}
      <button
        onClick={togglePower}
        className={`mt-6 flex w-full items-center justify-between rounded-3xl border-2 px-6 py-6 text-left transition-colors ${
          powered ? "border-amber bg-amber/15" : "border-line bg-panel"
        }`}
      >
        <div className="flex items-center gap-4">
          <span className={`grid h-14 w-14 place-items-center rounded-2xl ${powered ? "bg-amber text-ink" : "bg-ink text-mist"}`}>
            <Power className="h-7 w-7" />
          </span>
          <div>
            <div className={`text-3xl font-semibold ${powered ? "text-amber" : "text-mist"}`}>{powered ? "ON" : "OFF"}</div>
            <div className="mt-1 text-sm text-mist">
              {powered ? "One platform logo active on rear glass" : "Tablet is blank, idle, saving power"}
            </div>
          </div>
        </div>
        <span className={`relative h-9 w-16 rounded-full transition-colors ${powered ? "bg-amber" : "bg-ink"}`}>
          <span className={`absolute top-1 h-7 w-7 rounded-full bg-cream transition-all ${powered ? "left-8" : "left-1"}`} />
        </span>
      </button>

      <div className="mt-4 rounded-2xl border border-line bg-panel px-4 py-3 text-xs text-mist">
        {powered
          ? "One logo is displayed at a time. Select several apps and the glass rotates through them cinematically."
          : "Turn ON to wake the tablet. OFF makes the rear glass fully blank black and releases display power."}
      </div>

      <section className={`mt-3 rounded-2xl border px-4 py-3 ${safeToDisplay ? "border-amber/40 bg-amber/10" : "border-line bg-panel"}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] tracking-[0.22em] text-mist">MOTION SAFETY GATE</p>
            <p className="mt-1 text-sm text-cream">
              {!motionGate ? "Disabled · platform may display while moving" : !motion.allowed ? "Location permission required · rear stays blank" : !motion.isStationary ? `Moving ${kph(motion.speedMps ?? 0)} km/h · rear stays blank` : secondsLeft > 0 ? `Stopped · display unlocks in ${secondsLeft}s` : "Stopped long enough · rear display allowed"}
            </p>
          </div>
          <span className={`rounded-full px-2 py-1 text-[10px] tracking-widest ${safeToDisplay ? "bg-amber text-ink" : "bg-ink text-mist"}`}>{safeToDisplay ? "DISPLAY READY" : "BLANK"}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
          <button onClick={() => setMotionOverride(undefined)} className={`rounded-full px-2.5 py-1 ${motionOverride === undefined ? "bg-cream text-ink" : "bg-ink text-mist"}`}>GPS</button>
          <button onClick={() => setMotionOverride(false)} className={`rounded-full px-2.5 py-1 ${motionOverride === false ? "bg-cream text-ink" : "bg-ink text-mist"}`}>Test driving</button>
          <button onClick={() => setMotionOverride(true)} className={`rounded-full px-2.5 py-1 ${motionOverride === true ? "bg-cream text-ink" : "bg-ink text-mist"}`}>Test stopped</button>
        </div>
      </section>

      <div className="mt-3 flex items-center justify-between rounded-2xl border border-line bg-panel px-4 py-3">
        <div className="flex items-center gap-2">
          <BatteryCharging className="h-4 w-4 text-amber" />
          <div>
            <p className="text-[10px] tracking-[0.2em] text-mist">REAR TABLET BATTERY</p>
            <p className="text-sm text-cream">
              {battery ? `${battery.percentage}% · ${battery.charging ? "Charging" : "On battery"}` : "Waiting for battery telemetry"}
            </p>
          </div>
        </div>
        {battery && <span className="text-xs text-mist">{new Date(battery.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
      </div>

      {alert && (
        <div className="mt-3 flex items-center gap-2 rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-xs text-amber">
          <Bell className="h-4 w-4 shrink-0" />
          {alert}
        </div>
      )}

      {role !== "driver" && devices.length > 0 && (
        <section className="mt-5">
          <p className="text-[10px] tracking-[0.24em] text-amber">ACTIVE DEVICES · THIS PAIR CODE</p>
          <div className="mt-2 space-y-2">
            {devices.map((device) => (
              <div key={device.deviceId ?? device.updatedAt} className="flex items-center justify-between rounded-2xl border border-line bg-panel px-4 py-3 text-xs">
                <div>
                  <p className="text-cream">{device.deviceName ?? "Rear tablet"}</p>
                  <p className="mt-0.5 text-mist">Code {device.pairCode ?? driver?.pairCode}</p>
                </div>
                <span className="text-amber">{device.percentage}% · {device.charging ? "Charging" : "Battery"}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-mist">Cross-code fleet monitoring requires a server-backed admin directory. This browser build monitors all live tablets on this pairing code.</p>
        </section>
      )}

      <section className="mt-8 rounded-3xl border border-line bg-panel p-4">
        <p className="text-[11px] tracking-[0.32em] text-amber">DISPLAY GROUP CONTROL</p>
        <p className="mt-2 text-xs text-mist">Global ON powers both groups. Choose which display group is active without changing the other group’s saved configuration.</p>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <button onClick={() => activateDisplays("rear")} className={`rounded-xl py-2 ${settings.rearMasterOn !== false && settings.frontMasterOn === false ? "bg-amber text-ink" : "bg-ink text-mist"}`}>Rear only</button>
          <button onClick={() => activateDisplays("front")} className={`rounded-xl py-2 ${settings.frontMasterOn !== false && settings.rearMasterOn === false ? "bg-amber text-ink" : "bg-ink text-mist"}`}>Front only</button>
          <button onClick={() => activateDisplays("both")} className={`rounded-xl py-2 ${settings.frontMasterOn !== false && settings.rearMasterOn !== false ? "bg-amber text-ink" : "bg-ink text-mist"}`}>Both</button>
        </div>
      </section>

      {rearPrimary && <ProfilePlatformPicker profile={rearPrimary} title="REAR DEFAULT APPS" powered={powered && masterForPosition("rear", settings)} onChange={onProfileChange} />}
      {frontPrimary && <ProfilePlatformPicker profile={frontPrimary} title="FRONT DEFAULT APPS" powered={powered && masterForPosition("front", settings)} onChange={onProfileChange} />}

      <section className="mt-8">
        <p className="text-[11px] tracking-[0.32em] text-amber">CONNECTED DEVICE CONTROLS</p>
        <p className="mt-2 text-xs text-mist">Global ON/OFF controls both groups. Individual profile controls override one front or rear tablet at a time.</p>
        <div className="mt-3 space-y-3">
          {controls.map((profile) => {
            const batteryForDevice = devices.find((device) => device.deviceId === profile.deviceId || device.pairCode === profile.pairCode);
            const telemetryForDevice = profile.deviceId ? telemetry[profile.deviceId] : Object.values(telemetry).find((item) => item.pairCode === profile.pairCode);
            return (
              <DeviceControlCard
                key={profile.id}
                profile={profile}
                battery={batteryForDevice}
                telemetry={telemetryForDevice}
                now={now}
                campaigns={settings.commercialCampaigns ?? []}
                allowCommercial={allowCommercial}
                onPreview={() => setMirrorProfileId(profile.id)}
                onChange={onProfileChange}
              />
            );
          })}
        </div>
      </section>

      {mirrorProfile && (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <p className="text-[11px] tracking-[0.32em] text-amber">LIVE DEVICE MIRROR</p>
            <button onClick={() => setMirrorProfileId(null)} className="text-xs text-mist hover:text-cream">Close</button>
          </div>
          <p className="mt-2 text-xs text-mist">This is a real-time renderer mirror using the exact profile sent to this device. Browser privacy does not permit a raw remote screen capture without explicit device sharing and a WebRTC service.</p>
          <div className="tablet-frame mt-3 overflow-hidden bg-black" style={{ aspectRatio: telemetryAspect(mirrorTelemetry) }}>
            <div className="h-full w-full">
              <DisplayScreen
                preview
                ride={null}
                position={mirrorProfile.position}
                powered={powered && mirrorProfile.powered}
                settings={{ ...settings, deviceProfiles: [], masterOn: powered && mirrorProfile.powered, apps: mirrorProfile.apps, brightness: mirrorProfile.brightness, adaptiveBrightness: mirrorProfile.adaptiveBrightness, displayDurationSeconds: mirrorProfile.displayDurationSeconds, includeBlank: mirrorProfile.includeBlank, blankDurationSeconds: mirrorProfile.blankDurationSeconds }}
              />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function ProfilePlatformPicker({ profile, title, powered, onChange }: { profile: DeviceProfile; title: string; powered: boolean; onChange: (profile: DeviceProfile) => void }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[11px] tracking-[0.32em] text-amber">{title}</h2>
        <span className={`rounded-full px-2 py-1 text-[10px] tracking-widest ${powered ? "bg-amber text-ink" : "bg-ink text-mist"}`}>{powered ? "ACTIVE GROUP" : "GROUP OFF"}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {PLATFORMS.map((platform) => {
          const selected = profile.apps.includes(platform.id);
          return (
            <button key={platform.id} onClick={() => {
              if (selected && profile.apps.length === 1) return;
              onChange({ ...profile, apps: selected ? profile.apps.filter((id) => id !== platform.id) : [...profile.apps, platform.id] });
            }} className={`rounded-2xl border px-4 py-3 text-left ${selected ? "border-amber bg-amber/10" : "border-line bg-panel"}`}>
              <span className="inline-grid h-8 w-8 place-items-center rounded-lg font-cond text-[10px]" style={{ background: platform.color, color: platform.text }}>{platform.short.slice(0, 2)}</span>
              <div className="mt-2 text-sm font-medium">{platform.name}</div>
              <div className="text-[10px] text-mist">{selected ? "Selected" : "Tap to add"}</div>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-mist">This {profile.position} playlist is independent. One selection is fixed; multiple selections rotate under that device profile.</p>
    </section>
  );
}

function DeviceControlCard({
  profile,
  battery,
  telemetry,
  now,
  campaigns,
  allowCommercial,
  onPreview,
  onChange,
}: {
  profile: DeviceProfile;
  battery?: TabletBattery;
  telemetry?: DeviceTelemetry;
  now: number;
  campaigns: CommercialCampaign[];
  allowCommercial: boolean;
  onPreview: () => void;
  onChange: (profile: DeviceProfile) => void;
}) {
  const toggleApp = (id: string) => {
    if (profile.apps.includes(id) && profile.apps.length === 1) return;
    onChange({ ...profile, apps: profile.apps.includes(id) ? profile.apps.filter((app) => app !== id) : [...profile.apps, id] });
  };
  return (
    <div className="rounded-3xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-cream">{profile.position === "front" ? "FRONT" : "REAR"} · {profile.label}</p>
          <p className="text-[10px] tracking-[0.18em] text-mist">{profile.position.toUpperCase()} CODE {profile.pairCode}{profile.deviceId ? ` · ${profile.deviceId.slice(-5)}` : ""}</p>
        </div>
        <button onClick={() => onChange({ ...profile, powered: !profile.powered })} className={`rounded-full px-3 py-1.5 text-xs font-medium ${profile.powered ? "bg-amber text-ink" : "bg-ink text-mist"}`}>
          {profile.powered ? "DEVICE ON" : "DEVICE OFF"}
        </button>
      </div>
      {battery && <p className="mt-2 text-xs text-mist">Battery {battery.percentage}% · {battery.charging ? "Charging" : "On battery"}</p>}
      {telemetry && (
        <div className="mt-2 rounded-xl bg-ink px-3 py-2 text-[10px] leading-relaxed text-mist">
          <p className="text-cream">LIVE · {formatAgo(now - telemetry.at)} ago · {telemetry.displayState.toUpperCase()}{telemetry.activeContent ? ` · ${telemetry.activeContent}` : ""}</p>
          <p>{telemetry.screen} · DPR {telemetry.devicePixelRatio} · {telemetry.connection ?? "network unknown"}{telemetry.rttMs ? ` · ${telemetry.rttMs}ms` : ""}</p>
          <p>Memory {telemetry.deviceMemoryGb ? `${telemetry.deviceMemoryGb}GB` : "n/a"} · JS heap {telemetry.jsHeapUsedMb ? `${telemetry.jsHeapUsedMb}MB` : "n/a"} · uptime {formatUptime(telemetry.uptimeSeconds)}</p>
        </div>
      )}
      <button onClick={onPreview} className="mt-3 rounded-xl border border-amber/40 px-3 py-2 text-xs text-amber">View live screen mirror</button>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {PLATFORMS.map((platform) => (
          <button key={platform.id} onClick={() => toggleApp(platform.id)} className={`rounded-full px-2.5 py-1 text-[10px] ${profile.apps.includes(platform.id) ? "bg-cream text-ink" : "bg-ink text-mist"}`}>
            {platform.name}
          </button>
        ))}
      </div>
      {allowCommercial && (
        <div className="mt-4 border-t border-line pt-3">
          <Toggle label="Commercial playlist" on={profile.commercialEnabled ?? false} onChange={(commercialEnabled) => onChange({ ...profile, commercialEnabled })} />
          <div className="mt-3"><Toggle label="Parked confirmation for campaigns" on={profile.commercialParkedConfirmed ?? false} onChange={(commercialParkedConfirmed) => onChange({ ...profile, commercialParkedConfirmed })} /></div>
          <p className="mt-2 text-[10px] leading-relaxed text-mist">Campaigns remain blocked in NSW Safety Mode until this device is manually confirmed parked. A stopped traffic queue is not automatically treated as legally parked.</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {campaigns.filter((campaign) => campaign.approved && campaign.legal && (campaign.target ?? "both") !== (profile.position === "front" ? "rear" : "front")).map((campaign) => {
              const selected = profile.campaignIds?.includes(campaign.id) ?? false;
              return <button key={campaign.id} onClick={() => onChange({ ...profile, campaignIds: selected ? (profile.campaignIds ?? []).filter((id) => id !== campaign.id) : [...(profile.campaignIds ?? []), campaign.id] })} className={`rounded-full px-2.5 py-1 text-[10px] ${selected ? "bg-amber text-ink" : "bg-ink text-mist"}`}>{campaign.title}</button>;
            })}
            {campaigns.length === 0 && <p className="text-[10px] text-mist">Create approved campaign media in Owner Enterprise Lab first.</p>}
          </div>
        </div>
      )}
      {profile.position === "front" && (
        <div className="mt-4 border-t border-line pt-3">
          <Toggle label="Optional passenger name" on={profile.passengerNameEnabled ?? false} onChange={(passengerNameEnabled) => onChange({ ...profile, passengerNameEnabled })} />
          {profile.passengerNameEnabled && <input value={profile.passengerName ?? ""} onChange={(event) => onChange({ ...profile, passengerName: event.target.value.slice(0, 28) })} placeholder="Passenger name (optional)" className="mt-3 w-full rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-amber" />}
          <p className="mt-2 text-[10px] text-mist">Disabled by default. Front display remains motion-gated and is intended for passenger-facing/device-safe placement.</p>
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <label>Logo seconds · {profile.displayDurationSeconds.toFixed(1)}
          <input type="range" min={0.5} max={30} step={0.5} value={profile.displayDurationSeconds} onChange={(e) => onChange({ ...profile, displayDurationSeconds: Number(e.target.value) })} className="mt-1 w-full" />
        </label>
        <label>Brightness · {profile.brightness}%
          <input type="range" min={15} max={100} step={1} value={profile.brightness} onChange={(e) => onChange({ ...profile, brightness: Number(e.target.value) })} className="mt-1 w-full" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Toggle label="Blank between loop" on={profile.includeBlank} onChange={(includeBlank) => onChange({ ...profile, includeBlank })} />
        <Toggle label="Auto brightness" on={profile.adaptiveBrightness} onChange={(adaptiveBrightness) => onChange({ ...profile, adaptiveBrightness })} />
      </div>
      {profile.includeBlank && (
        <label className="mt-3 block text-xs">Blank seconds · {profile.blankDurationSeconds.toFixed(1)}
          <input type="range" min={0.5} max={15} step={0.5} value={profile.blankDurationSeconds} onChange={(e) => onChange({ ...profile, blankDurationSeconds: Number(e.target.value) })} className="mt-1 w-full" />
        </label>
      )}
    </div>
  );
}

function formatAgo(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function telemetryAspect(telemetry?: DeviceTelemetry) {
  if (!telemetry?.screen) return "16 / 9";
  const match = telemetry.screen.match(/(\d+)\D+(\d+)/);
  if (!match) return "16 / 9";
  return `${match[1]} / ${match[2]}`;
}



function DisplayTab({ connectedCodes }: { connectedCodes: string[] }) {
  const { driver, rotatePair, rotateFrontPair } = useStore();
  // Query display mode is supported by the active Arena host, unlike a static
  // tablet.html asset which can be absent on an older deployment.
  const tabletBase = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "/";
  const devices = [
    { position: "rear" as const, title: "Rear Glass", code: driver?.pairCode ?? "", description: "Exterior-facing rear window display" },
    { position: "front" as const, title: "Front Display", code: driver?.frontPairCode ?? "", description: "Passenger-facing / driver-safe front tablet" },
  ];

  return (
    <div className="px-5 py-6">
      <p className="text-[11px] tracking-[0.4em] text-amber">DISPLAY DEVICES</p>
      <h1 className="mt-2 font-display text-3xl">Pair rear and front.</h1>
      <div className="mt-6 space-y-4">
        {devices.map((device) => {
          const url = `${tabletBase}?mode=tablet&position=${device.position}&display=${device.code}`;
          const qr = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&bgcolor=050505&color=E8A317&data=${encodeURIComponent(url)}`;
          const connected = connectedCodes.includes(device.code);
          return <div key={device.position} className="rounded-3xl border border-line bg-panel p-5 text-center">
            <div className="flex items-center justify-between"><p className="text-sm font-medium">{device.title}</p><span className={`text-[10px] tracking-[0.18em] ${connected ? "text-amber" : "text-mist"}`}>{connected ? "CONNECTED" : "WAITING"}</span></div>
            <p className="mt-1 text-xs text-mist">{device.description}</p>
            <p className="mt-4 font-cond text-4xl tracking-[0.22em] text-amber">{formatPair(device.code)}</p>
            <img src={qr} alt={`${device.title} pairing QR`} className="mx-auto mt-4 h-40 w-40 rounded-2xl border border-line" />
            <p className="mt-3 break-all text-[10px] text-mist">{url}</p>
            <div className="mt-4 flex justify-center gap-2"><button onClick={() => { window.open(url, "_blank", "noopener"); }} className="rounded-xl bg-cream px-4 py-2 text-xs font-semibold text-ink">Preview {device.title}</button><button onClick={() => device.position === "front" ? rotateFrontPair() : rotatePair()} className="rounded-xl border border-line px-3 py-2 text-xs text-cream">New code</button></div>
          </div>;
        })}
      </div>
      <ol className="mt-6 space-y-3 text-sm text-mist">
        <li>1. Rear is for rear-window use. Front is intended for passenger-facing or driver-safe placement.</li>
        <li>2. Each tablet has an independent pair code, profile, brightness, platforms and campaigns.</li>
        <li>3. Scan the matching QR, authorize the display, then manage it from the driver phone.</li>
        <li>4. The global master and separate Rear/Front group controls determine which devices are active.</li>
      </ol>
      <div className="mt-8 grid grid-cols-2 gap-3 text-sm">
        <Tip icon={BatteryCharging} t="Stays awake while ON" d="Each display holds screen and fullscreen while allowed by the driver safety gate." />
        <Tip icon={Tablet} t="Independent profiles" d="Front and rear pairing codes and device profiles are separate." />
        <Tip icon={Smartphone} t="Phone is the brain" d="Flip the switch on your phone. The glass follows instantly." />
        <Tip icon={Car} t="OFF means idle" d="Turning OFF drops the tablet to black and frees resources." />
      </div>
    </div>
  );
}

function HistoryTab({
  rides,
  logs,
  role,
}: {
  rides: import("../types").Ride[];
  logs: import("../types").ActivityLog[];
  role: DriverRole;
}) {
  const done = useMemo(() => rides.filter((r) => r.status === "complete" || r.completedAt), [rides]);
  return (
    <div className="px-5 py-6">
      <p className="text-[11px] tracking-[0.4em] text-amber">CURB LOG</p>
      <h1 className="mt-2 font-display text-3xl">{done.length} sessions</h1>
      <div className="mt-6 space-y-2">
        {rides.length === 0 && <p className="text-sm text-mist">No sessions recorded yet. This log grows as you use the switch.</p>}
        {rides.map((r) => (
          <div key={r.id} className="flex items-center justify-between rounded-2xl border border-line bg-panel px-4 py-3">
            <div>
              <div className="font-medium capitalize">{getPlatform(r.platform).name}</div>
              <div className="text-xs text-mist">{new Date(r.createdAt).toLocaleString()}</div>
            </div>
            <span className="text-[10px] tracking-widest" style={{ color: getPlatform(r.platform).accent }}>
              {getPlatform(r.platform).short}
            </span>
          </div>
        ))}
      </div>
      <h2 className="mt-10 text-[11px] tracking-[0.3em] text-amber">ACTIVITY LEDGER</h2>
      <div className="mt-3 space-y-2">
        {logs.length === 0 && <p className="text-sm text-mist">No device activity recorded on this browser yet.</p>}
        {logs.map((log) => (
          <details key={log.id} className="rounded-2xl border border-line bg-panel px-4 py-3">
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-cream">{log.action}</p>
                  <p className="mt-1 text-[10px] text-mist">{new Date(log.at).toLocaleString()} · {log.pairCode ?? "No pair"}{log.deviceName ? ` · ${log.deviceName}` : ""}</p>
                </div>
                <span className="text-[10px] tracking-widest text-amber">DETAILS</span>
              </div>
            </summary>
            {role !== "driver" && (
              <div className="mt-3 border-t border-line pt-3 text-xs text-mist">
                {log.deviceId && <p>Device ID: {log.deviceId}</p>}
                {log.platforms?.length ? <p className="mt-1">Platforms: {log.platforms.join(", ")}</p> : null}
                {log.details && Object.entries(log.details).map(([key, value]) => <p key={key} className="mt-1">{key}: {String(value)}</p>)}
              </div>
            )}
          </details>
        ))}
      </div>
    </div>
  );
}

function SettingsTab() {
  const { driver, settings, saveSettings, updateVehicle, updateDriver, recordActivity } = useStore();
  const privileged = driver?.role === "admin" || driver?.role === "supervisor";
  const admin = driver?.role === "admin";
  const sourceOwner = isSourceOwner(driver?.email);
  const sourceAccess = canDownloadSource(driver?.email);
  const [pairCodeInput, setPairCodeInput] = useState("");
  const addFleetPair = () => {
    const pairCode = pairCodeInput.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (pairCode.length !== 6) return;
    const exists = settings.deviceProfiles?.some((profile) => profile.pairCode === pairCode && !profile.deviceId);
    if (exists) return;
    saveSettings({ deviceProfiles: [...(settings.deviceProfiles ?? []), createDeviceProfile({ pairCode, label: `Fleet pair ${pairCode}` })] });
    setPairCodeInput("");
  };
  return (
    <div className="px-5 py-6">
      <p className="text-[11px] tracking-[0.4em] text-amber">BOOTH</p>
      <h1 className="mt-2 font-display text-3xl">How the glass behaves.</h1>

      <div className="mt-6 space-y-3">
        <Toggle label="Platform wordmark" on={settings.showPlatform} onChange={(v) => saveSettings({ showPlatform: v })} />
        <Toggle label="Color identification bar" on={settings.showColorBar} onChange={(v) => saveSettings({ showColorBar: v })} />
        <Toggle label="Sleep pin-light" on={settings.sleepIndicator} onChange={(v) => saveSettings({ sleepIndicator: v })} />
      </div>

      <label className="mt-6 block text-sm">
        Screen brightness · {settings.brightness}%
        <input type="range" min={50} max={100} value={settings.brightness} onChange={(e) => saveSettings({ brightness: Number(e.target.value) })} className="mt-2 w-full" />
      </label>

      <div className="mt-5 flex gap-2">
        {(["auto", "day", "night", "amber"] as const).map((th) => (
          <button key={th} onClick={() => saveSettings({ theme: th })} className={`flex-1 rounded-xl py-2 text-xs uppercase tracking-widest ${settings.theme === th ? "bg-amber text-ink" : "bg-panel text-mist"}`}>
            {th}
          </button>
        ))}
      </div>

      <h2 className="mt-10 text-[11px] tracking-[0.3em] text-mist">MOTION SAFETY</h2>
      <div className="mt-3 rounded-2xl border border-line bg-panel p-4">
        <Toggle label="Display only while stopped" on={settings.motionSafetyGate ?? true} onChange={(motionSafetyGate) => saveSettings({ motionSafetyGate })} />
        <div className="mt-3"><Toggle label="Front tablet is visible to driver" on={settings.frontDriverVisible ?? false} onChange={(frontDriverVisible) => saveSettings({ frontDriverVisible })} /></div>
        <label className="mt-4 block text-sm">
          Moving cutoff · {settings.stationarySpeedKph ?? 1} km/h
          <input type="range" min={0} max={5} step={0.5} value={settings.stationarySpeedKph ?? 1} onChange={(event) => saveSettings({ stationarySpeedKph: Number(event.target.value) })} className="mt-2 w-full" />
        </label>
        <label className="mt-4 block text-sm">
          Stationary wait · {settings.stationaryWaitSeconds ?? 60} sec
          <input type="range" min={10} max={300} step={10} value={settings.stationaryWaitSeconds ?? 60} onChange={(event) => saveSettings({ stationaryWaitSeconds: Number(event.target.value) })} className="mt-2 w-full" />
        </label>
        <p className="mt-3 text-[10px] leading-relaxed text-mist">Default: rear display stays blank above 1 km/h. After the vehicle remains at or below the cutoff for 60 seconds, selected platform/campaign content may appear. Disable only for approved parked/private use.</p>
        <p className="mt-2 text-[10px] leading-relaxed text-amber">If the front tablet is driver-visible, keep the motion gate enabled and treat commercial display as parked-only unless you have site-specific legal approval.</p>
      </div>

      <h2 className="mt-10 text-[11px] tracking-[0.3em] text-mist">WORDMARK STYLE</h2>
      <div className="mt-3 flex gap-2">
        <button onClick={() => saveSettings({ platformBackgroundMode: "brand" })} className={`flex-1 rounded-xl py-2 text-xs ${settings.platformBackgroundMode !== "black" ? "bg-amber text-ink" : "bg-panel text-mist"}`}>Original brand colour</button>
        <button onClick={() => saveSettings({ platformBackgroundMode: "black" })} className={`flex-1 rounded-xl py-2 text-xs ${settings.platformBackgroundMode === "black" ? "bg-amber text-ink" : "bg-panel text-mist"}`}>Black + white</button>
      </div>
      <div className="mt-3"><Toggle label="Embossed 3D wordmark" on={settings.wordmarkEmbossed ?? true} onChange={(wordmarkEmbossed) => saveSettings({ wordmarkEmbossed })} /></div>
      {admin && (
        <div className="mt-3">
          <Toggle label="Fade in / fade out" on={!!settings.fadeTransitions && !(settings.nswSafetyMode ?? true)} onChange={(fadeTransitions) => saveSettings({ fadeTransitions: (settings.nswSafetyMode ?? true) ? false : fadeTransitions })} />
          <p className="mt-2 text-[10px] leading-relaxed text-mist">NSW Safety Mode forces hard static transitions. Disable it only for approved private/off-road campaigns; fade is not treated as driver-visible compliance mode.</p>
        </div>
      )}

      <h2 className="mt-10 text-[11px] tracking-[0.3em] text-mist">BATTERY ALERTS</h2>
      <div className="mt-3 rounded-2xl border border-line bg-panel p-4">
        <Toggle label="Tablet battery alerts" on={settings.batteryAlertsEnabled ?? true} onChange={(v) => saveSettings({ batteryAlertsEnabled: v })} />
        <label className="mt-4 block text-sm">
          Alert every {settings.batteryAlertStep ?? 1}% change
          <input type="range" min={1} max={20} step={1} value={settings.batteryAlertStep ?? 1} onChange={(e) => saveSettings({ batteryAlertStep: Number(e.target.value) })} className="mt-2 w-full" />
        </label>
        <label className="mt-4 block text-sm">
          Alert cooldown · {settings.batteryAlertCooldownMinutes ?? 1} min
          <input type="range" min={1} max={30} step={1} value={settings.batteryAlertCooldownMinutes ?? 1} onChange={(e) => saveSettings({ batteryAlertCooldownMinutes: Number(e.target.value) })} className="mt-2 w-full" />
        </label>
        <p className="mt-3 text-[10px] leading-relaxed text-mist">Native browser battery data is used where Android exposes it. Alerts stop at 100% and at/below 5%, while monitoring continues.</p>
      </div>

      <h2 className="mt-10 text-[11px] tracking-[0.3em] text-mist">RIDESHARE APPS</h2>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {PLATFORMS.map((p) => {
          const on = driver?.platforms.includes(p.id);
          return (
            <button
              key={p.id}
              onClick={() => {
                if (!driver) return;
                if (on && driver.platforms.length === 1) return;
                const platforms = on ? driver.platforms.filter((x) => x !== p.id) : [...driver.platforms, p.id];
                updateDriver({ platforms });
              }}
              className={`rounded-2xl border px-3 py-3 text-left ${on ? "border-amber bg-amber/10" : "border-line bg-panel"}`}
            >
              <div className="font-medium">{p.name}</div>
              <div className="text-[11px] text-mist">{p.blurb}</div>
            </button>
          );
        })}
      </div>

      <h2 className="mt-10 text-[11px] tracking-[0.3em] text-mist">VEHICLE</h2>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <SmallIn label="Make" value={driver?.vehicle.make ?? ""} onChange={(v) => updateVehicle({ make: v })} />
        <SmallIn label="Model" value={driver?.vehicle.model ?? ""} onChange={(v) => updateVehicle({ model: v })} />
        <SmallIn label="Color" value={driver?.vehicle.color ?? ""} onChange={(v) => updateVehicle({ color: v })} />
        <SmallIn label="Plate" value={driver?.vehicle.plate ?? ""} onChange={(v) => updateVehicle({ plate: v.toUpperCase() })} />
      </div>

      <h2 className="mt-10 text-[11px] tracking-[0.3em] text-mist">GUIDE</h2>
      {privileged ? (
        <div className="mt-3 rounded-2xl border border-amber/30 bg-amber/10 p-4 text-sm text-mist">
          <p className="font-medium text-cream">{driver?.role === "admin" ? "Admin" : "Supervisor"} technical guide</p>
          <p className="mt-2">Use the Glass tab to verify QR pair status, active same-code devices and tablet battery telemetry. Cross-code fleet supervision needs a server-backed directory when you move beyond local browser pairing.</p>
        </div>
      ) : (
        <div className="mt-3 rounded-2xl border border-line bg-panel p-4 text-sm text-mist">Driver guide: select your platform, switch ON, confirm the rear logo, and switch OFF when your shift ends.</div>
      )}

      {privileged && (
        <>
          <h2 className="mt-10 text-[11px] tracking-[0.3em] text-mist">FLEET PAIR CODES</h2>
          <p className="mt-2 text-xs text-mist">Add a six-character pair code to centrally control a tablet on a different code. Individual devices appear after they connect.</p>
          <div className="mt-3 flex gap-2">
            <input value={pairCodeInput} onChange={(e) => setPairCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))} placeholder="9Q4T2K" className="min-w-0 flex-1 rounded-xl border border-line bg-ink px-3 py-2 font-cond tracking-[0.2em] outline-none focus:border-amber" />
            <button onClick={addFleetPair} className="rounded-xl bg-amber px-4 py-2 text-xs font-semibold text-ink">Add code</button>
          </div>
          <div className="mt-3 space-y-2">
            {(settings.deviceProfiles ?? []).filter((profile) => !profile.deviceId).map((profile) => (
              <div key={profile.id} className="flex items-center justify-between rounded-xl border border-line bg-panel px-3 py-2 text-xs">
                <span>{profile.label} · <span className="text-amber">{profile.pairCode}</span></span>
                <button onClick={() => saveSettings({ deviceProfiles: (settings.deviceProfiles ?? []).filter((item) => item.id !== profile.id) })} className="text-mist hover:text-cream">Remove</button>
              </div>
            ))}
          </div>
        </>
      )}

      {sourceAccess && (
        <>
          <h2 className="mt-10 text-[11px] tracking-[0.3em] text-mist">OWNER SOURCE VAULT</h2>
          <div className="mt-3 rounded-2xl border border-amber/30 bg-amber/10 p-4 text-sm text-mist">
            <p className="font-medium text-cream">{sourceOwner ? "Owner" : "Demo admin"} source session active</p>
            <p className="mt-2">Generate the current source archive here. It is not listed in the public application. Keep the resulting archive and repository access private.</p>
            <button onClick={() => { window.location.hash = "/source-vault"; }} className="mt-4 rounded-xl bg-amber px-4 py-2 text-xs font-semibold text-ink">Open Source Vault</button>
          </div>
        </>
      )}

      {admin && <EnterpriseLab settings={settings} saveSettings={saveSettings} recordActivity={recordActivity} />}
    </div>
  );
}

type QaPhaseId = "preflight" | "admission" | "transport" | "dispatch" | "acknowledge" | "recovery" | "report";

interface QaRunState {
  phase: QaPhaseId;
  phaseLabel: string;
  progress: number;
  startedAt: number;
  elapsedMs: number;
  admitted: number;
  connected: number;
  dispatched: number;
  acknowledged: number;
  recovered: number;
  failed: number;
}

const QA_PHASES: Array<{ id: QaPhaseId; label: string; detail: string; weight: number; screen: "blank" | "platform" | "campaign" }> = [
  { id: "preflight", label: "Preflight validation", detail: "Validating safety policy, selected campaign assets, profile payload size and simulation limits.", weight: 0.08, screen: "blank" },
  { id: "admission", label: "Virtual device admission ramp", detail: "Ramping simulated device records in controlled batches; no real sockets are created.", weight: 0.26, screen: "blank" },
  { id: "transport", label: "Transport and command queue", detail: "Simulating authentication, connection admission and command queue distribution.", weight: 0.16, screen: "blank" },
  { id: "dispatch", label: "Display state dispatch", detail: "Simulating platform/campaign payload delivery to the admitted device population.", weight: 0.18, screen: "platform" },
  { id: "acknowledge", label: "Acknowledgement validation", detail: "Simulating device acknowledgements and ensuring the intended display state is received.", weight: 0.16, screen: "platform" },
  { id: "recovery", label: "Network recovery rehearsal", detail: "Simulating temporary mobile-network loss, cached state retention and reconnect delivery.", weight: 0.12, screen: "blank" },
  { id: "report", label: "Evidence report", detail: "Calculating simulated dispatch, acknowledgement and recovery evidence for the local audit log.", weight: 0.04, screen: "platform" },
];

function EnterpriseLab({ settings, saveSettings, recordActivity }: { settings: DisplaySettings; saveSettings: (patch: Partial<DisplaySettings>) => void; recordActivity: (entry: Omit<import("../types").ActivityLog, "id" | "at" | "actorId">) => void }) {
  const [title, setTitle] = useState("");
  const [assetDataUrl, setAssetDataUrl] = useState("");
  const [mediaType, setMediaType] = useState<CommercialCampaign["mediaType"]>("image");
  const [displaySeconds, setDisplaySeconds] = useState(10);
  const [discountText, setDiscountText] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [campaignTarget, setCampaignTarget] = useState<"both" | "rear" | "front">("both");
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [qaTarget, setQaTarget] = useState(settings.enterpriseQa?.targetDevices ?? 100000);
  const [qaDurationSeconds, setQaDurationSeconds] = useState(settings.enterpriseQa?.runDurationSeconds ?? 45);
  const [qaRunning, setQaRunning] = useState(false);
  const [qaRun, setQaRun] = useState<QaRunState | null>(null);
  const [qaEvents, setQaEvents] = useState<Array<{ at: number; phase: QaPhaseId; label: string; detail: string }>>([]);
  const qaTimer = useRef<number | null>(null);
  const qaLoggedPhases = useRef<Set<QaPhaseId>>(new Set());
  const qaLoggedCheckpoints = useRef<Set<number>>(new Set());
  const nswSafety = settings.nswSafetyMode ?? true;
  const campaigns = settings.commercialCampaigns ?? [];
  const [legal, setLegal] = useState<CommercialCampaignLegal>(() => blankCampaignLegal());

  const updateConsent = (key: keyof Pick<CommercialCampaignLegal, "appOwner" | "driver" | "vehicleOwner" | "campaignOwner" | "trademarkAuthorization" | "safetyAssessment">, patch: Partial<LegalConsent>) => {
    setLegal((current) => ({
      ...current,
      [key]: {
        ...current[key],
        ...patch,
        confirmedAt: patch.confirmed === true ? Date.now() : patch.confirmed === false ? undefined : current[key].confirmedAt,
      },
    }));
  };

  const issueConsent = async (role: ConsentRole) => {
    if (!title.trim()) {
      setCampaignError("Enter a campaign title before issuing an agreement PDF.");
      return;
    }
    const consent = legal[role];
    if (!consent.signerName.trim() || !(consent.email ?? "").trim() || !consent.agreementReference.trim()) {
      setCampaignError("Each signed consent needs the legal signer name, email, and written agreement reference.");
      return;
    }
    const signed: LegalConsent = { ...consent, confirmed: true, confirmedAt: Date.now(), signedDocumentAt: Date.now(), deliveryStatus: "prepared" };
    let nextLegal: CommercialCampaignLegal = { ...legal, [role]: signed };
    if (role === "driver" && legal.driverIsVehicleOwner) {
      nextLegal = { ...nextLegal, vehicleOwner: { ...signed, agreementReference: `${signed.agreementReference} · driver is vehicle owner` } };
    }
    setLegal(nextLegal);
    const file = createConsentPdf({ campaignTitle: title.trim(), role, consent: signed, legal: nextLegal, nswSafetyMode: nswSafety });
    const recipients = [...new Set([SOURCE_OWNER_EMAIL, signed.email, nextLegal.driver.email, nextLegal.vehicleOwner.email, nextLegal.campaignOwner.email].filter(Boolean))];
    const delivery = await deliverAgreementPdf(file, recipients, `Retroflex signed consent · ${title.trim()}`);
    setLegal((current) => ({ ...current, [role]: { ...current[role], deliveryStatus: delivery, signedDocumentAt: signed.signedDocumentAt } }));
    recordActivity({ action: "Consent PDF issued", details: { campaign: title.trim(), role, signer: signed.signerName, signerEmail: signed.email, reference: signed.agreementReference, delivery } });
    setCampaignError(null);
  };

  const issueFullAuthorization = async () => {
    const issues = campaignLegalIssues(legal, Boolean(discountText.trim() || referralCode.trim()));
    if (issues.length || !title.trim()) {
      setCampaignError(issues[0] ?? "Enter campaign title before issuing the full authorization pack.");
      return;
    }
    const issuedAt = Date.now();
    const nextLegal = { ...legal, fullAuthorizationIssuedAt: issuedAt, fullAuthorizationDelivery: "prepared" as const };
    setLegal(nextLegal);
    const file = createConsentPdf({ campaignTitle: `${title.trim()} · Full authorization pack`, role: "appOwner", consent: nextLegal.appOwner, legal: nextLegal, nswSafetyMode: nswSafety });
    const recipients = [...new Set([SOURCE_OWNER_EMAIL, nextLegal.appOwner.email, nextLegal.driver.email, nextLegal.vehicleOwner.email, nextLegal.campaignOwner.email, nextLegal.trademarkAuthorization.email].filter(Boolean))];
    const delivery = await deliverAgreementPdf(file, recipients, `Retroflex full campaign authorization · ${title.trim()}`);
    setLegal((current) => ({ ...current, fullAuthorizationIssuedAt: issuedAt, fullAuthorizationDelivery: delivery }));
    recordActivity({ action: "Full campaign authorization PDF issued", details: { campaign: title.trim(), recipients: recipients.join(", "), delivery } });
    setCampaignError(null);
  };

  const uploadAsset = (file: File | undefined) => {
    if (!file) return;
    setCampaignError(null);
    const type: CommercialCampaign["mediaType"] = file.type.startsWith("video/") ? "video" : file.type === "image/gif" ? "gif" : "image";
    if (nswSafety && type !== "image") {
      setCampaignError("NSW Safety Mode accepts static image files only. GIF and video are not approved for a driver-visible campaign display.");
      return;
    }
    if (file.size > 1_500_000) {
      setCampaignError("Local browser campaign storage is capped at 1.5MB per asset. Use a compressed static image for this pilot.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAssetDataUrl(String(reader.result ?? ""));
      setMediaType(type);
    };
    reader.onerror = () => setCampaignError("Could not read the selected asset.");
    reader.readAsDataURL(file);
  };

  const addCampaign = () => {
    if (!title.trim() || !assetDataUrl) {
      setCampaignError("Add a campaign title and an approved image asset first.");
      return;
    }
    const issues = campaignLegalIssues(legal, Boolean(discountText.trim() || referralCode.trim()));
    if (issues.length) {
      setCampaignError(issues[0]);
      return;
    }
    const campaign: CommercialCampaign = {
      id: `cmp_${Date.now().toString(36)}`,
      title: title.trim(),
      mediaType,
      assetDataUrl,
      discountText: nswSafety ? undefined : discountText.trim() || undefined,
      referralCode: nswSafety ? undefined : referralCode.trim() || undefined,
      displaySeconds: nswSafety ? Math.max(10, displaySeconds) : Math.max(0.5, displaySeconds),
      enabled: true,
      approved: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      legal,
      target: campaignTarget,
    };
    saveSettings({ commercialCampaigns: [...campaigns, campaign] });
    recordActivity({ action: "Commercial campaign approved", details: { campaign: campaign.title, mediaType: campaign.mediaType, dwellSeconds: campaign.displaySeconds, nswSafetyMode: nswSafety, merchant: campaign.legal?.merchantName } });
    setTitle("");
    setAssetDataUrl("");
    setDiscountText("");
    setReferralCode("");
    setCampaignTarget("both");
    setLegal(blankCampaignLegal());
    setCampaignError(null);
  };

  useEffect(() => () => {
    if (qaTimer.current) window.clearTimeout(qaTimer.current);
  }, []);

  const runQa = () => {
    const target = Math.max(100, Math.min(250000, qaTarget));
    const started = performance.now();
    setQaRunning(true);
    setQaEvents([]);
    qaLoggedPhases.current = new Set();
    qaLoggedCheckpoints.current = new Set();
    recordActivity({
      action: "Enterprise QA simulation started",
      details: {
        targetDevices: target,
        configuredDurationSeconds: qaDurationSeconds,
        simulationOnly: true,
        transport: "No physical sockets or remote devices created",
      },
    });
    const totalMs = Math.max(15, Math.min(180, qaDurationSeconds)) * 1000;
    const cumulativeWeights = QA_PHASES.reduce<number[]>((all, phase, index) => {
      all.push((all[index - 1] ?? 0) + phase.weight);
      return all;
    }, []);

    const tick = () => {
      const elapsedMs = performance.now() - started;
      const progress = Math.min(1, elapsedMs / totalMs);
      const phaseIndex = Math.min(QA_PHASES.length - 1, cumulativeWeights.findIndex((weight) => progress <= weight));
      const phase = QA_PHASES[phaseIndex];
      const previousWeight = cumulativeWeights[phaseIndex - 1] ?? 0;
      const phaseProgress = Math.max(0, Math.min(1, (progress - previousWeight) / phase.weight));
      const admitted = Math.round(target * Math.min(1, Math.max(0, (progress - 0.06) / 0.44)));
      const connected = Math.round(admitted * (0.998 - Math.min(0.002, progress / 100)));
      const dispatched = Math.round(target * Math.max(0, Math.min(1, (progress - 0.42) / 0.30)));
      const acknowledged = Math.round(dispatched * (0.995 + Math.min(0.004, phaseProgress / 100)));
      const recovered = progress > 0.78 ? Math.round(target * Math.min(0.018, (progress - 0.78) * 0.08)) : 0;
      const failed = Math.max(0, dispatched - acknowledged);
      setQaRun({ phase: phase.id, phaseLabel: phase.label, progress, startedAt: Date.now() - Math.round(elapsedMs), elapsedMs: Math.round(elapsedMs), admitted, connected, dispatched, acknowledged, recovered, failed });
      if (!qaLoggedPhases.current.has(phase.id)) {
        qaLoggedPhases.current.add(phase.id);
        recordActivity({
          action: `QA phase: ${phase.label}`,
          details: {
            targetDevices: target,
            progressPercent: Math.round(progress * 100),
            admitted,
            connected,
            dispatched,
            acknowledged,
            recovered,
            unacknowledged: failed,
            simulationOnly: true,
          },
        });
      }
      [25, 50, 75].forEach((checkpoint) => {
        if (progress * 100 >= checkpoint && !qaLoggedCheckpoints.current.has(checkpoint)) {
          qaLoggedCheckpoints.current.add(checkpoint);
          recordActivity({
            action: `QA progress checkpoint: ${checkpoint}%`,
            details: { targetDevices: target, admitted, connected, dispatched, acknowledged, recovered, unacknowledged: failed, elapsedMs: Math.round(elapsedMs), simulationOnly: true },
          });
        }
      });
      setQaEvents((events) => {
        if (events.at(-1)?.phase === phase.id) return events;
        return [...events, { at: Date.now(), phase: phase.id, label: phase.label, detail: phase.detail }];
      });
      if (progress < 1) {
        qaTimer.current = window.setTimeout(tick, 250);
        return;
      }
      const duration = Math.round(performance.now() - started);
      const completed = { targetDevices: target, simulatedOnline: connected, lastRunAt: Date.now(), lastRunDurationMs: duration, estimatedDispatchPerSecond: Math.round((dispatched / Math.max(duration, 1)) * 1000), runDurationSeconds: qaDurationSeconds, admittedDevices: admitted, acknowledgedDevices: acknowledged, recoveredDevices: recovered, failedDevices: failed, note: "Browser control-plane simulation only. No physical network devices, PeerJS sessions or sockets were created." };
      saveSettings({ enterpriseQa: completed });
      recordActivity({ action: "Enterprise QA simulation completed", details: { target, durationMs: duration, admitted, acknowledged, recovered, failed } });
      setQaRunning(false);
      qaTimer.current = null;
    };
    tick();
  };

  return (
    <section className="mt-10 border-t border-amber/30 pt-8">
      <p className="text-[11px] tracking-[0.35em] text-amber">ADMIN ENTERPRISE LAB</p>
      <h2 className="mt-2 font-display text-3xl">Commercial signage and QA.</h2>
      <p className="mt-3 text-sm leading-relaxed text-mist">Owner-only local pilot controls. Campaign assets remain in this browser cache. No commercial content is sent to a rear tablet unless selected in that device’s profile.</p>

      <div className="mt-5 rounded-3xl border border-amber/30 bg-amber/10 p-4 text-sm text-mist">
        <Toggle label="NSW Safety Mode" on={nswSafety} onChange={(nswSafetyMode) => saveSettings({ nswSafetyMode, fadeTransitions: nswSafetyMode ? false : settings.fadeTransitions })} />
        <div className="mt-3"><Toggle label="Remote diagnostics overlay" on={settings.diagnosticsOverlay ?? false} onChange={(diagnosticsOverlay) => saveSettings({ diagnosticsOverlay })} /></div>
        <p className="mt-3 leading-relaxed">When enabled: static images only, at least 10 seconds per campaign, no animated/video media, no QR/referral overlay, and black is the failure/blank frame. Confirm permits, vehicle requirements, approval, placement and road-safety compliance with NSW authorities before any public deployment. This app does not grant legal approval.</p>
        <p className="mt-2 text-xs">Diagnostics overlay displays small white device telemetry at upper left for owner QA. Turn it off for any passenger/public-facing deployment.</p>
      </div>

      <div className="mt-6 rounded-3xl border border-line bg-panel p-4">
        <p className="text-[11px] tracking-[0.3em] text-amber">CAMPAIGN ASSET UPLOAD</p>
        <div className="mt-3 space-y-3">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Campaign title" className="w-full rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-amber" />
          <input type="file" accept={nswSafety ? "image/png,image/jpeg,image/webp" : "image/*,video/*"} onChange={(event) => uploadAsset(event.target.files?.[0])} className="block w-full text-xs text-mist file:mr-3 file:rounded-lg file:border-0 file:bg-cream file:px-3 file:py-2 file:text-xs file:font-semibold file:text-ink" />
          <div className="grid grid-cols-3 gap-2 text-xs">
            {(["both", "rear", "front"] as const).map((target) => <button key={target} onClick={() => setCampaignTarget(target)} className={`rounded-xl py-2 ${campaignTarget === target ? "bg-amber text-ink" : "bg-ink text-mist"}`}>{target === "both" ? "Rear + front" : `${target} only`}</button>)}
          </div>
          {!nswSafety && <div className="grid grid-cols-2 gap-2"><input value={discountText} onChange={(event) => setDiscountText(event.target.value)} placeholder="Discount text" className="rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-amber" /><input value={referralCode} onChange={(event) => setReferralCode(event.target.value)} placeholder="Referral code" className="rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-amber" /></div>}
          <label className="block text-xs">Campaign dwell · {displaySeconds.toFixed(1)} sec<input type="range" min={nswSafety ? 10 : 0.5} max={60} step={0.5} value={displaySeconds} onChange={(event) => setDisplaySeconds(Number(event.target.value))} className="mt-2 w-full" /></label>
          <div className="rounded-2xl border border-amber/30 bg-amber/10 p-3 text-xs leading-relaxed text-mist">
            <p className="font-medium text-cream">Written permission register</p>
            <p className="mt-1">Record the signed agreement reference and signer for the app owner, driver, display vehicle owner, campaign company/agency, trademark authorization and safety assessment. A physical sticker or possession of a logo is not automatically a trademark/display licence; record explicit authorization from the rights holder.</p>
          </div>
          <div className="space-y-2">
            <ConsentRow label="App owner ↔ driver ↔ display car owner agreement" consent={legal.appOwner} onChange={(patch) => updateConsent("appOwner", patch)} onIssue={() => issueConsent("appOwner")} />
            <ConsentRow label="Driver display consent" consent={legal.driver} onChange={(patch) => updateConsent("driver", patch)} onIssue={() => issueConsent("driver")} />
            <div className="rounded-xl border border-line bg-ink p-3">
              <Toggle label="Driver is the registered display car owner" on={legal.driverIsVehicleOwner} onChange={(driverIsVehicleOwner) => setLegal((current) => ({
                ...current,
                driverIsVehicleOwner,
                vehicleOwner: driverIsVehicleOwner && current.driver.confirmed
                  ? { ...current.driver, agreementReference: `${current.driver.agreementReference} · driver is vehicle owner` }
                  : current.vehicleOwner,
              }))} />
              <p className="mt-2 text-[10px] text-mist">If enabled, signing the driver consent also records that driver as the vehicle owner. If not, the separate display car owner must sign and receive their PDF copy.</p>
            </div>
            {!legal.driverIsVehicleOwner && <ConsentRow label="Display car owner consent" consent={legal.vehicleOwner} onChange={(patch) => updateConsent("vehicleOwner", patch)} onIssue={() => issueConsent("vehicleOwner")} />}
            <ConsentRow label="Campaign company / agency agreement" consent={legal.campaignOwner} onChange={(patch) => updateConsent("campaignOwner", patch)} onIssue={() => issueConsent("campaignOwner")} />
            <ConsentRow label="Trademark/logo authorization" consent={legal.trademarkAuthorization} onChange={(patch) => updateConsent("trademarkAuthorization", patch)} onIssue={() => issueConsent("trademarkAuthorization")} />
            <ConsentRow label="NSW/site-specific safety assessment" consent={legal.safetyAssessment} onChange={(patch) => updateConsent("safetyAssessment", patch)} onIssue={() => issueConsent("safetyAssessment")} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input value={legal.merchantName} onChange={(event) => setLegal((current) => ({ ...current, merchantName: event.target.value }))} placeholder="Merchant / campaign company" className="rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-amber" />
            <input type="date" value={legal.offerExpiry ?? ""} onChange={(event) => setLegal((current) => ({ ...current, offerExpiry: event.target.value }))} className="rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-amber" />
            <input value={legal.privacyPolicyUrl ?? ""} onChange={(event) => setLegal((current) => ({ ...current, privacyPolicyUrl: event.target.value }))} placeholder="Privacy policy URL" className="col-span-2 rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-amber" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Toggle label="QR/referral terms clear" on={legal.qrTermsConfirmed} onChange={(qrTermsConfirmed) => setLegal((current) => ({ ...current, qrTermsConfirmed }))} />
            <Toggle label="No rider data without consent" on={legal.noRiderDataWithoutConsent} onChange={(noRiderDataWithoutConsent) => setLegal((current) => ({ ...current, noRiderDataWithoutConsent }))} />
          </div>
          <div className="rounded-xl border border-amber/30 bg-amber/10 p-3 text-xs text-mist">
            <p className="font-medium text-cream">Final written campaign authority</p>
            <p className="mt-1">After all parties sign their individual consent records, issue one full campaign authorization PDF to the app owner/admin, driver, vehicle owner and campaign company/agency.</p>
            <button onClick={issueFullAuthorization} className="mt-3 rounded-lg bg-amber px-3 py-2 text-xs font-semibold text-ink">Issue full authorization PDF</button>
            {legal.fullAuthorizationIssuedAt && <p className="mt-2 text-amber">Issued {new Date(legal.fullAuthorizationIssuedAt).toLocaleString()} · {legal.fullAuthorizationDelivery}</p>}
          </div>
          {assetDataUrl && <img src={assetDataUrl} alt="Campaign preview" className="max-h-40 w-full rounded-xl object-cover" />}
          {campaignError && <p className="text-xs text-rose-400">{campaignError}</p>}
          <button onClick={addCampaign} className="rounded-xl bg-amber px-4 py-2 text-sm font-semibold text-ink">Approve campaign asset</button>
        </div>
        <div className="mt-5 space-y-2">
          {campaigns.map((campaign) => <div key={campaign.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-ink px-3 py-2 text-xs"><span className="min-w-0 truncate text-cream">{campaign.title} · {campaign.target ?? "both"} · {campaign.mediaType} · {campaign.displaySeconds}s</span><button onClick={() => saveSettings({ commercialCampaigns: campaigns.filter((item) => item.id !== campaign.id) })} className="text-mist hover:text-cream">Remove</button></div>)}
        </div>
      </div>

      <div className="mt-6 rounded-3xl border border-line bg-panel p-4">
        <p className="text-[11px] tracking-[0.3em] text-amber">100K CONTROL-PLANE QA SIMULATION</p>
        <p className="mt-2 text-xs leading-relaxed text-mist">This is not a 100k remote-device connection test. It is a paced browser simulation with visible admission, dispatch, acknowledgement and recovery stages. It deliberately creates no WebSocket, PeerJS or physical device connections. A true 100k QA test requires cloud load generators, a realtime broker, observability and a staging backend.</p>
        <label className="mt-4 block text-sm">Simulated devices · {qaTarget.toLocaleString()}<input type="range" min={1000} max={250000} step={1000} value={qaTarget} onChange={(event) => setQaTarget(Number(event.target.value))} className="mt-2 w-full" /></label>
        <label className="mt-4 block text-sm">Run duration · {qaDurationSeconds} sec<input type="range" min={15} max={180} step={5} value={qaDurationSeconds} onChange={(event) => setQaDurationSeconds(Number(event.target.value))} className="mt-2 w-full" /></label>
        <button onClick={runQa} disabled={qaRunning} className="mt-4 rounded-xl bg-cream px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40">{qaRunning ? `${Math.round((qaRun?.progress ?? 0) * 100)}% · ${qaRun?.phaseLabel ?? "Starting"}` : "Run staged QA simulation"}</button>

        {qaRun && (
          <div className="mt-5">
            <div className="h-2 overflow-hidden rounded-full bg-ink"><div className="h-full bg-amber transition-[width] duration-200" style={{ width: `${qaRun.progress * 100}%` }} /></div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <QaMetric label="Admitted" value={qaRun.admitted} />
              <QaMetric label="Connected" value={qaRun.connected} />
              <QaMetric label="Dispatched" value={qaRun.dispatched} />
              <QaMetric label="Acknowledged" value={qaRun.acknowledged} />
              <QaMetric label="Recovered" value={qaRun.recovered} />
              <QaMetric label="Unacknowledged" value={qaRun.failed} />
            </div>
            <div className="mt-4 rounded-2xl border border-line bg-ink p-3">
              <p className="text-[10px] tracking-[0.22em] text-amber">SIMULATED REAR DISPLAY SAMPLE</p>
              <QaDisplayPreview phase={qaRun.phase} campaign={campaigns.find((campaign) => campaign.approved && campaign.enabled)} />
            </div>
            <div className="mt-4 space-y-2">
              {QA_PHASES.map((phase) => {
                const event = qaEvents.find((item) => item.phase === phase.id);
                const active = qaRun.phase === phase.id;
                return <div key={phase.id} className={`rounded-xl border px-3 py-2 text-xs ${active ? "border-amber bg-amber/10" : event ? "border-line bg-ink" : "border-line/50 bg-ink/50 text-mist"}`}><p className={active ? "text-amber" : "text-cream"}>{event ? "✓" : active ? "●" : "○"} {phase.label}</p><p className="mt-1 text-[10px] text-mist">{phase.detail}</p></div>;
              })}
            </div>
          </div>
        )}
        {settings.enterpriseQa?.lastRunAt && <p className="mt-4 text-xs text-mist">Last simulation: {settings.enterpriseQa.simulatedOnline?.toLocaleString()} connected model · {settings.enterpriseQa.admittedDevices?.toLocaleString()} admitted · {settings.enterpriseQa.acknowledgedDevices?.toLocaleString()} acknowledged · {settings.enterpriseQa.recoveredDevices?.toLocaleString()} recovery events · {settings.enterpriseQa.lastRunDurationMs}ms.</p>}
      </div>
    </section>
  );
}

function QaMetric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl bg-panel px-3 py-2"><p className="text-[9px] tracking-widest text-mist">{label.toUpperCase()}</p><p className="mt-1 font-cond text-xl text-cream">{value.toLocaleString()}</p></div>;
}

function QaDisplayPreview({ phase, campaign }: { phase: QaPhaseId; campaign?: CommercialCampaign }) {
  const state = QA_PHASES.find((item) => item.id === phase)?.screen ?? "blank";
  if (state === "blank") return <div className="mt-3 aspect-[16/6] rounded-xl bg-black" />;
  if (state === "campaign" && campaign) return <img src={campaign.assetDataUrl} alt="Simulated campaign" className="mt-3 aspect-[16/6] w-full rounded-xl object-cover" />;
  return <div className="mt-3 grid aspect-[16/6] place-items-center rounded-xl bg-[#FF6A00]"><span className="font-cond text-[12vw] font-bold tracking-[0.08em] text-white">DiDi</span></div>;
}

function blankConsent(): LegalConsent {
  return { confirmed: false, signerName: "", agreementReference: "", email: "", deliveryStatus: "not-issued" };
}

function blankCampaignLegal(): CommercialCampaignLegal {
  return {
    appOwner: { ...blankConsent(), email: SOURCE_OWNER_EMAIL },
    driver: blankConsent(),
    vehicleOwner: blankConsent(),
    campaignOwner: blankConsent(),
    trademarkAuthorization: blankConsent(),
    safetyAssessment: blankConsent(),
    merchantName: "",
    offerExpiry: "",
    privacyPolicyUrl: "",
    qrTermsConfirmed: false,
    noRiderDataWithoutConsent: false,
    driverIsVehicleOwner: false,
  };
}

function campaignLegalIssues(legal: CommercialCampaignLegal, requiresOfferTerms: boolean) {
  const named = [
    ["App owner / driver / display car agreement", legal.appOwner],
    ["Driver display consent", legal.driver],
    ["Display car owner consent", legal.vehicleOwner],
    ["Campaign company / agency agreement", legal.campaignOwner],
    ["Trademark/logo authorization", legal.trademarkAuthorization],
    ["NSW/site safety assessment", legal.safetyAssessment],
  ] as const;
  for (const [label, consent] of named) {
    if (!consent.confirmed || !consent.signerName.trim() || !(consent.email ?? "").trim() || !consent.agreementReference.trim()) {
      return [`Record a signed ${label} with signer and agreement reference before approving this campaign.`];
    }
  }
  if (requiresOfferTerms && (!(legal.merchantName ?? "").trim() || !legal.offerExpiry || !legal.privacyPolicyUrl || !legal.qrTermsConfirmed || !legal.noRiderDataWithoutConsent)) {
    return ["Referral/discount campaigns require merchant name, expiry, privacy policy URL, clear terms confirmation and rider-data consent confirmation."];
  }
  return [];
}

function ConsentRow({ label, consent, onChange, onIssue }: { label: string; consent: LegalConsent; onChange: (patch: Partial<LegalConsent>) => void; onIssue: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-ink p-3">
      <div className="flex items-center justify-between gap-3"><p className="text-sm text-cream">{label}</p><span className={`rounded-full px-2 py-1 text-[9px] tracking-widest ${consent.confirmed ? "bg-amber text-ink" : "bg-panel text-mist"}`}>{consent.confirmed ? "SIGNED" : "PENDING"}</span></div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <input value={consent.signerName} onChange={(event) => onChange({ signerName: event.target.value })} placeholder="Signer name" className="min-w-0 rounded-lg border border-line bg-panel px-2 py-2 text-xs outline-none focus:border-amber" />
        <input type="email" value={consent.email} onChange={(event) => onChange({ email: event.target.value })} placeholder="Signer email" className="min-w-0 rounded-lg border border-line bg-panel px-2 py-2 text-xs outline-none focus:border-amber" />
        <input value={consent.agreementReference} onChange={(event) => onChange({ agreementReference: event.target.value })} placeholder="Agreement ID / secure URL" className="min-w-0 rounded-lg border border-line bg-panel px-2 py-2 text-xs outline-none focus:border-amber" />
      </div>
      <button onClick={onIssue} className="mt-3 rounded-lg bg-cream px-3 py-2 text-xs font-semibold text-ink">{consent.confirmed ? "Reissue signed PDF" : "Sign & issue PDF"}</button>
      {consent.signedDocumentAt && <p className="mt-2 text-[10px] text-mist">Signed {new Date(consent.signedDocumentAt).toLocaleString()} · delivery {consent.deliveryStatus}</p>}
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className="flex w-full items-center justify-between rounded-2xl border border-line bg-panel px-4 py-3 text-sm">
      {label}
      <span className={`grid h-6 w-6 place-items-center rounded-full ${on ? "bg-amber text-ink" : "bg-ink text-mist"}`}>
        {on && <Check className="h-3.5 w-3.5" />}
      </span>
    </button>
  );
}

function SmallIn({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-[10px] tracking-widest text-mist">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-ink px-3 py-2 text-sm text-cream outline-none focus:border-amber" />
    </label>
  );
}

function Tip({ icon: Icon, t, d }: { icon: typeof Tablet; t: string; d: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-3">
      <Icon className="h-4 w-4 text-amber" />
      <p className="mt-2 font-medium">{t}</p>
      <p className="text-xs text-mist">{d}</p>
    </div>
  );
}
