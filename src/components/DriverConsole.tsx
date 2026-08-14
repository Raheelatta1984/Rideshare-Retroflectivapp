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
import { Check } from "lucide-react";
import type { DeviceProfile, TabletBattery, TabletDevice } from "../types";
import { codeProfileId, createDeviceProfile, deviceProfileId, profileForDevice } from "../lib/devices";
import { canDownloadSource, isSourceOwner } from "../lib/access";
import { Logo } from "./Logo";

type Tab = "live" | "display" | "history" | "settings";

export function DriverConsole({ go }: { go: (p: string) => void }) {
  const store = useStore();
  const { driver, powered, setPowered, settings, saveSettings, rides, logs, activeRide, clearRide, updateDriver, recordActivity } = store;
  const [tab, setTab] = useState<Tab>("live");
  const [tabletBattery, setTabletBattery] = useState<TabletBattery | null>(null);
  const [deviceBatteries, setDeviceBatteries] = useState<Record<string, TabletBattery>>({});
  const [connectedDevices, setConnectedDevices] = useState<Record<string, TabletDevice>>({});
  const [batteryAlert, setBatteryAlert] = useState<string | null>(null);
  const lastBatteryBucket = useRef<number | null>(null);
  const lastBatteryAlertAt = useRef(0);
  const alertTimer = useRef<number | null>(null);

  const primaryProfile = driver ? createDeviceProfile({
    id: codeProfileId(driver.pairCode),
    pairCode: driver.pairCode,
    label: `Pair ${driver.pairCode}`,
    powered: true,
    apps: driver.platforms,
  }) : null;
  const deviceProfiles = useMemo(() => {
    const saved = settings.deviceProfiles ?? [];
    if (!primaryProfile || saved.some((profile) => profile.id === primaryProfile.id)) return saved;
    return [primaryProfile, ...saved];
  }, [settings.deviceProfiles, primaryProfile?.id, driver?.platforms, driver?.pairCode]);
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
    if (driver && profile.id === codeProfileId(driver.pairCode)) updateDriver({ platforms: profile.apps });
  };

  const receiveBattery = (battery: TabletBattery) => {
    setTabletBattery(battery);
    const id = battery.deviceId ?? "current-tablet";
    setDeviceBatteries((devices) => ({ ...devices, [id]: battery }));
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
    if (packet.type === "hello" && packet.device) {
      const device = { ...packet.device, pairCode, lastSeen: Date.now() };
      setConnectedDevices((devices) => ({ ...devices, [device.id]: device }));
      if (!connectedDevices[device.id]) {
        recordActivity({ action: "Tablet connected", pairCode, deviceId: device.id, deviceName: device.name });
      }
      if (!deviceProfiles.some((profile) => profile.deviceId === device.id)) {
        const source = profileForDevice(deviceProfiles, undefined, pairCode);
        upsertProfile(createDeviceProfile({ ...source, id: deviceProfileId(device.id), deviceId: device.id, pairCode, label: device.name }));
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
          masterOn: powered && profile.powered,
          apps: profile.apps,
          displayDurationSeconds: profile.displayDurationSeconds,
          includeBlank: profile.includeBlank,
          blankDurationSeconds: profile.blankDurationSeconds,
          brightness: profile.brightness,
          adaptiveBrightness: profile.adaptiveBrightness,
        },
        ride: activeRide,
      };
    });
  }, [powered, settings, activeRide, deviceProfiles, driver?.id]);

  useEffect(() => {
    if (!driver) return;
    Object.values(connectedDevices).forEach((device) => {
      const profile = profileForDevice(deviceProfiles, device, device.pairCode);
      publishTo(device.pairCode, {
        type: "settings",
        targetDeviceId: device.id,
        settings: {
          ...settings,
          deviceProfiles,
          masterOn: powered && profile.powered,
          apps: profile.apps,
          displayDurationSeconds: profile.displayDurationSeconds,
          includeBlank: profile.includeBlank,
          blankDurationSeconds: profile.blankDurationSeconds,
          brightness: profile.brightness,
          adaptiveBrightness: profile.adaptiveBrightness,
        },
        ride: activeRide,
      });
    });
  }, [connectedDevices, deviceProfiles, powered, settings, activeRide, driver?.id]);

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
        {tab === "live" && <LiveTab powered={powered} setPowered={setPowered} battery={tabletBattery} devices={Object.values(deviceBatteries)} profiles={deviceProfiles} onProfileChange={upsertProfile} alert={batteryAlert} role={driver?.role ?? "driver"} />}
        {tab === "display" && <DisplayTab connected={connectedCodes.includes(driver.pairCode)} />}
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
  battery,
  devices,
  profiles,
  onProfileChange,
  alert,
  role,
}: {
  powered: boolean;
  setPowered: (on: boolean) => void;
  battery: TabletBattery | null;
  devices: TabletBattery[];
  profiles: DeviceProfile[];
  onProfileChange: (profile: DeviceProfile) => void;
  alert: string | null;
  role: "admin" | "supervisor" | "driver";
}) {
  const { driver } = useStore();
  const platforms = PLATFORMS;
  const primary = profiles.find((profile) => profile.pairCode === driver?.pairCode && !profile.deviceId) ?? (driver ? createDeviceProfile({ pairCode: driver.pairCode, apps: driver.platforms }) : null);
  // Keep profiles after a tablet disconnects so the next connection restores its last local setup.
  const controls = profiles;

  const togglePower = () => {
    if (!powered && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    setPowered(!powered);
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

      {/* Default / primary pairing profile */}
      {primary && (
      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] tracking-[0.32em] text-amber">RIDESHARE APPS</h2>
          <span className={`rounded-full px-2 py-1 text-[10px] tracking-widest ${powered ? "bg-amber text-ink" : "bg-ink text-mist"}`}>
            {powered ? "ONE LOGO AT A TIME" : "HIDDEN"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {platforms.map((p) => {
            const on = primary.apps.includes(p.id);
            return (
              <button
                key={p.id}
                onClick={() => {
                  if (on && primary.apps.length === 1) return;
                  const apps = on ? primary.apps.filter((id) => id !== p.id) : [...primary.apps, p.id];
                  onProfileChange({ ...primary, apps });
                }}
                className={`rounded-2xl border px-4 py-4 text-left ${on ? "border-amber bg-amber/10" : "border-line bg-panel"}`}
              >
                <span
                  className="inline-grid h-9 w-9 place-items-center rounded-xl font-cond text-xs"
                  style={{ background: p.color, color: p.text }}
                >
                  {p.short.slice(0, 2)}
                </span>
                <div className="mt-3 font-medium">{p.name}</div>
                <div className="text-[11px] text-mist">{on ? "Displayed" : "Tap to add"}</div>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-mist">One selection = fixed logo. Several selections = automatic cinematic rotation every 4.5 seconds.</p>
      </section>
      )}

      <section className="mt-8">
        <p className="text-[11px] tracking-[0.32em] text-amber">CONNECTED DEVICE CONTROLS</p>
        <p className="mt-2 text-xs text-mist">Central ON/OFF controls all registered devices. These settings override one rear tablet at a time.</p>
        <div className="mt-3 space-y-3">
          {controls.map((profile) => {
            const batteryForDevice = devices.find((device) => device.deviceId === profile.deviceId || device.pairCode === profile.pairCode);
            return (
              <DeviceControlCard
                key={profile.id}
                profile={profile}
                battery={batteryForDevice}
                onChange={onProfileChange}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}

function DeviceControlCard({
  profile,
  battery,
  onChange,
}: {
  profile: DeviceProfile;
  battery?: TabletBattery;
  onChange: (profile: DeviceProfile) => void;
}) {
  const toggleApp = (id: import("../types").Platform) => {
    if (profile.apps.includes(id) && profile.apps.length === 1) return;
    onChange({ ...profile, apps: profile.apps.includes(id) ? profile.apps.filter((app) => app !== id) : [...profile.apps, id] });
  };
  return (
    <div className="rounded-3xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-cream">{profile.label}</p>
          <p className="text-[10px] tracking-[0.18em] text-mist">CODE {profile.pairCode}{profile.deviceId ? ` · ${profile.deviceId.slice(-5)}` : ""}</p>
        </div>
        <button onClick={() => onChange({ ...profile, powered: !profile.powered })} className={`rounded-full px-3 py-1.5 text-xs font-medium ${profile.powered ? "bg-amber text-ink" : "bg-ink text-mist"}`}>
          {profile.powered ? "DEVICE ON" : "DEVICE OFF"}
        </button>
      </div>
      {battery && <p className="mt-2 text-xs text-mist">Battery {battery.percentage}% · {battery.charging ? "Charging" : "On battery"}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {PLATFORMS.map((platform) => (
          <button key={platform.id} onClick={() => toggleApp(platform.id)} className={`rounded-full px-2.5 py-1 text-[10px] ${profile.apps.includes(platform.id) ? "bg-cream text-ink" : "bg-ink text-mist"}`}>
            {platform.name}
          </button>
        ))}
      </div>
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



function DisplayTab({ connected }: { connected: boolean }) {
  const { driver, rotatePair } = useStore();
  // Query display mode is supported by the active Arena host, unlike a static
  // tablet.html asset which can be absent on an older deployment.
  const tabletBase = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "/";
  const url = `${tabletBase}?mode=tablet&display=${driver?.pairCode}`;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&bgcolor=050505&color=E8A317&data=${encodeURIComponent(url)}`;

  return (
    <div className="px-5 py-6">
      <p className="text-[11px] tracking-[0.4em] text-amber">REAR TABLET</p>
      <h1 className="mt-2 font-display text-3xl">Pair the glass.</h1>
      <div className="mt-6 rounded-3xl border border-line bg-panel p-6 text-center">
        <p className="font-cond text-5xl tracking-[0.28em] text-amber">{formatPair(driver?.pairCode ?? "")}</p>
        <img src={qr} alt="Pairing QR" className="mx-auto mt-6 h-44 w-44 rounded-2xl border border-line" />
        <p className="mt-4 break-all text-[11px] text-mist">{url}</p>
        <p className={`mt-4 text-[11px] tracking-[0.24em] ${connected ? "text-amber" : "text-mist"}`}>
          {connected ? "TABLET CONNECTED" : "WAITING FOR TABLET"}
        </p>
      </div>
      <ol className="mt-6 space-y-3 text-sm text-mist">
        <li>1. Mount the Android tablet landscape on the inside of the rear window, screen facing out.</li>
        <li>2. Plug into the charger. While the switch is ON the display keeps itself awake and fullscreen.</li>
        <li>3. Open this site on the tablet → Arm display → enter the code, or scan the QR.</li>
        <li>4. Flip the ON switch on your phone to wake the glass.</li>
      </ol>
      <div className="mt-6 flex gap-2">
        <button onClick={() => { window.open(url, "_blank", "noopener"); }} className="flex-1 rounded-2xl bg-cream py-3 font-semibold text-ink">
          Preview display
        </button>
        <button onClick={() => rotatePair()} className="rounded-2xl border border-line px-4 py-3 text-sm">
          New code
        </button>
      </div>
      <div className="mt-8 grid grid-cols-2 gap-3 text-sm">
        <Tip icon={BatteryCharging} t="Stays awake while ON" d="The display holds the screen and fullscreen until you switch it OFF — no plug required." />
        <Tip icon={Tablet} t="Landscape only" d="App tiles are sized for the long edge of the screen." />
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
  role: "admin" | "supervisor" | "driver";
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
  const { driver, settings, saveSettings, updateVehicle, updateDriver } = useStore();
  const privileged = driver?.role === "admin" || driver?.role === "supervisor";
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
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
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
