import { useEffect, useMemo, useRef, useState } from "react";
import { Battery, BatteryCharging, Maximize, RotateCcw } from "lucide-react";
import type { DisplaySettings, MotionState, Platform, Ride, TabletBattery } from "../types";
import { defaultSettings } from "../lib/storage";
import { PLATFORMS, getPlatform } from "../lib/platforms";
import { profileForDevice } from "../lib/devices";
import { t } from "../lib/i18n";
import { usePairChannel } from "../lib/sync";
import { useMotion } from "../lib/motion";
import { requestWakeLock, useNow } from "../hooks";
import { ChevronMark } from "./Logo";

interface Props {
  pairCode?: string;
  ride?: Ride | null;
  settings?: DisplaySettings;
  powered?: boolean;
  preview?: boolean;
  demoStopped?: boolean;
  onExit?: () => void;
}

interface BrowserBatteryManager {
  level: number;
  charging: boolean;
  addEventListener: (event: "levelchange" | "chargingchange", handler: () => void) => void;
  removeEventListener: (event: "levelchange" | "chargingchange", handler: () => void) => void;
}

export function DisplayScreen({ pairCode, ride: rideProp, settings: settingsProp, powered: poweredProp, preview, demoStopped, onExit }: Props) {
  const [remoteRide, setRemoteRide] = useState<Ride | null>(null);
  const [remoteSettings, setRemoteSettings] = useState<DisplaySettings>(defaultSettings());
  const [taps, setTaps] = useState(0);
  const [tabletBattery, setTabletBattery] = useState<TabletBattery | null>(null);
  const [flash, setFlash] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasRemoteSync, setHasRemoteSync] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastStatus = useRef<string>("idle");
  const deviceIdRef = useRef(getTabletDeviceId());

  const { publish } = usePairChannel(pairCode, "display", (packet) => {
    if (packet.targetDeviceId && packet.targetDeviceId !== deviceIdRef.current) return;
    if (packet.ride !== undefined) setRemoteRide(packet.ride ?? null);
    if (packet.settings) {
      setRemoteSettings(packet.settings);
      setHasRemoteSync(true);
      if (pairCode) {
        localStorage.setItem(`rf:tablet-state:${pairCode.toUpperCase()}`, JSON.stringify({
          settings: packet.settings,
          ride: packet.ride ?? null,
          savedAt: Date.now(),
        }));
      }
    }
  });
  const publishRef = useRef(publish);
  publishRef.current = publish;

  useEffect(() => {
    if (!pairCode || preview) return;
    const hello = () => publishRef.current({
      type: "hello",
      device: {
        id: deviceIdRef.current,
        name: getTabletDeviceName(),
        pairCode,
        lastSeen: Date.now(),
      },
    });
    hello();
    const interval = window.setInterval(hello, 8000);
    return () => window.clearInterval(interval);
  }, [pairCode, preview]);

  // If the network or driver phone briefly disappears, hold the last authorized
  // display profile locally and reconnect in the background instead of losing control.
  useEffect(() => {
    if (!pairCode || settingsProp) return;
    try {
      const raw = localStorage.getItem(`rf:tablet-state:${pairCode.toUpperCase()}`);
      if (!raw) return;
      const saved = JSON.parse(raw) as { settings?: DisplaySettings; ride?: Ride | null };
      if (saved.settings) {
        setRemoteSettings(saved.settings);
        setRemoteRide(saved.ride ?? null);
      }
    } catch {
      /* retain default blank state */
    }
  }, [pairCode, settingsProp]);

  const ride = rideProp !== undefined ? rideProp : remoteRide;
  const settings = settingsProp ?? remoteSettings;
  const deviceProfile = settings.deviceProfiles?.length
    ? profileForDevice(settings.deviceProfiles, {
        id: deviceIdRef.current,
        name: getTabletDeviceName(),
        pairCode: pairCode ?? "",
        lastSeen: Date.now(),
      }, pairCode ?? "")
    : null;
  // Central power must be ON, then each tablet's own profile controls its display.
  const centralPowered = poweredProp !== undefined ? poweredProp : settings.masterOn !== false;
  const powered = centralPowered && (deviceProfile?.powered ?? true);
  const apps: Platform[] = deviceProfile?.apps?.length ? deviceProfile.apps : settings.apps?.length ? settings.apps : ["didi"];
  const motionGps = useMotion(!preview && !!ride && powered && ["en_route", "stopped"].includes(ride.status), demoStopped);
  const motion: MotionState = motionGps;

  // Keep the tablet awake + fullscreen while the driver switch is ON,
  // regardless of charge. Released when the driver switches OFF.
  useEffect(() => {
    if (preview) return;
    let lock: { release: () => Promise<void> } | null = null;

    const el = document.documentElement;
    if (powered) {
      requestWakeLock().then((l) => {
        lock = l;
      });
      if (el.requestFullscreen) {
        void el.requestFullscreen().catch(() => undefined);
      } else {
        const webkit = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
        void webkit.webkitRequestFullscreen?.();
      }
    }
    return () => {
      if (lock) void lock.release();
    };
  }, [preview, powered]);

  // Track fullscreen so we can show a one-tap "enter fullscreen on top" control.
  useEffect(() => {
    const sync = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const enterFullscreen = () => {
    const el = document.documentElement;
    if (el.requestFullscreen) {
      void el.requestFullscreen()
        .then(() => {
          const orientation = screen.orientation as ScreenOrientation & {
            lock?: (mode: "landscape" | "portrait") => Promise<void>;
          };
          return orientation.lock?.("landscape");
        })
        .catch(() => undefined);
    }
    else {
      const webkit = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      void webkit.webkitRequestFullscreen?.();
    }
  };

  // Battery Status API is browser/device dependent. When Android exposes it,
  // send the native percentage and charging state back to the driver phone.
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BrowserBatteryManager> };
    if (!nav.getBattery) return;
    let manager: BrowserBatteryManager | null = null;
    let disposed = false;

    const sync = () => {
      if (!manager || disposed) return;
      const next: TabletBattery = {
        percentage: Math.round(manager.level * 100),
        charging: manager.charging,
        updatedAt: Date.now(),
        deviceId: deviceIdRef.current,
        deviceName: getTabletDeviceName(),
        pairCode,
      };
      setTabletBattery(next);
      if (pairCode) publishRef.current({ type: "battery", battery: next });
    };

    nav.getBattery()
      .then((battery) => {
        if (disposed) return;
        manager = battery;
        sync();
        manager.addEventListener("levelchange", sync);
        manager.addEventListener("chargingchange", sync);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      if (manager) {
        manager.removeEventListener("levelchange", sync);
        manager.removeEventListener("chargingchange", sync);
      }
    };
  }, [pairCode]);

  useEffect(() => {
    if (!ride) return;
    if (ride.status !== lastStatus.current && ride.status === "arrived") {
      setFlash(true);
      const id = window.setTimeout(() => setFlash(false), 900);
      lastStatus.current = ride.status;
      return () => window.clearTimeout(id);
    }
    lastStatus.current = ride.status;
  }, [ride]);

  useEffect(() => {
    if (!ride || !pairCode) return;
    if (ride.status !== "en_route" && ride.status !== "stopped") return;
    if (motion.isStationary && motion.stoppedForMs >= settings.stopDelaySeconds * 1000) {
      publish({ type: "motion", motion, ride: { ...ride, status: "arrived", arrivedAt: new Date().toISOString() } });
    }
  }, [motion.stoppedForMs, motion.isStationary, ride?.status, settings.stopDelaySeconds, pairCode]);

  const hour = new Date().getHours();
  const theme = settings.theme === "auto" ? (hour >= 6 && hour < 18 ? "day" : "night") : settings.theme;
  const palette = palettes[theme];
  const platform = ride ? getPlatform(ride.platform) : null;
  const labels = t(settings.language);
  const status = ride?.status ?? "idle";
  // ON with no ride is the normal app-grid state. Only manual OFF should sleep the glass.
  const sleeping = !powered || status === "complete";
  const showApps = powered && (!ride || status === "idle");
  const waitingForPhone = !preview && !settingsProp && !!pairCode && !hasRemoteSync;

  const daylight = hour >= 7 && hour < 19;
  const configuredBrightness = deviceProfile?.brightness ?? settings.brightness ?? 70;
  const adaptiveBrightness = deviceProfile?.adaptiveBrightness ?? settings.adaptiveBrightness ?? true;
  const daylightBrightness = !adaptiveBrightness
    ? configuredBrightness
    : daylight
      ? Math.max(configuredBrightness, 82)
      : Math.min(configuredBrightness, 62);
  const batteryFactor = tabletBattery && tabletBattery.percentage <= 20
    ? Math.max(0.45, tabletBattery.percentage / 25)
    : 1;
  const brightness = Math.max(18, daylightBrightness * batteryFactor) / 100;

  return (
    <div
      ref={rootRef}
      onClick={() => {
        // The first tap on a live rear logo is a user-gesture fullscreen request.
        if (!preview && powered && showApps && !isFullscreen) {
          enterFullscreen();
          return;
        }
        setTaps((n) => {
          const next = n + 1;
          if (next >= 5) {
            onExit?.();
            return 0;
          }
          window.setTimeout(() => setTaps(0), 1800);
          return next;
        });
      }}
      className={`relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden ${flash ? "animate-arrive" : ""}`}
      style={{
        background: sleeping ? "#000" : palette.bg,
        color: palette.fg,
        // Rear rendering is always normal. The driver phone never auto-inverts this view.
        transform: undefined,
        filter: sleeping ? undefined : `brightness(${brightness})`,
      }}
    >
      {!sleeping && theme === "amber" && <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(232,163,23,0.18),transparent_60%)]" />}

      {waitingForPhone ? (
        <WaitingFace pairCode={pairCode} />
      ) : sleeping ? (
        <SleepFace />
      ) : showApps ? (
        <AppsFace
          apps={apps}
          displayDurationSeconds={deviceProfile?.displayDurationSeconds ?? settings.displayDurationSeconds ?? 4.5}
          includeBlank={deviceProfile?.includeBlank ?? settings.includeBlank ?? false}
          blankDurationSeconds={deviceProfile?.blankDurationSeconds ?? settings.blankDurationSeconds ?? 1.5}
        />
      ) : status === "incoming" ? (
        <IncomingFace ride={ride!} labels={labels} platformName={platform!.short} accent={platform!.accent} palette={palette} />
      ) : status === "stopped" ? (
        <CountdownFace ride={ride!} settings={settings} motion={motion} labels={labels} palette={palette} />
      ) : status === "arrived" ? (
        <ArrivedFace ride={ride!} settings={settings} labels={labels} palette={palette} platform={platform!.short} />
      ) : status === "dropoff" ? (
        <ThanksFace labels={labels} palette={palette} />
      ) : status === "in_trip" ? (
        <TripFace ride={ride!} labels={labels} palette={palette} />
      ) : (
        <EnRouteFace ride={ride!} settings={settings} labels={labels} palette={palette} platform={platform!.short} />
      )}

      {!preview && !sleeping && tabletBattery && (
        <div className="pointer-events-none absolute top-3 right-4 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-cream/75">
          {tabletBattery.charging ? <BatteryCharging className="h-4 w-4" /> : <Battery className="h-4 w-4" />}
          <span>{tabletBattery.percentage}%</span>
        </div>
      )}

      {!preview && powered && !isFullscreen && !showApps && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            enterFullscreen();
          }}
          aria-label="Enter fullscreen"
          className="absolute bottom-4 right-4 z-20 grid h-9 w-9 place-items-center rounded-full bg-black/70 text-cream/80"
        >
          <Maximize className="h-4 w-4" />
        </button>
      )}

      {taps >= 2 && !preview && (
        <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-[10px] tracking-widest text-cream/80">
          <Maximize className="h-3 w-3" /> TAP {5 - taps} MORE FOR CONTROLS
        </div>
      )}
    </div>
  );
}

function AppsFace({
  apps,
  displayDurationSeconds,
  includeBlank,
  blankDurationSeconds,
}: {
  apps: Platform[];
  displayDurationSeconds: number;
  includeBlank: boolean;
  blankDurationSeconds: number;
}) {
  const appKey = apps.join("|");
  const visible = useMemo(
    () => apps.map((id) => PLATFORMS.find((p) => p.id === id)).filter(Boolean) as Array<(typeof PLATFORMS)[number]>,
    [appKey],
  );
  const [index, setIndex] = useState(0);

  const playlist = includeBlank ? [...visible, null] : visible;
  const active = playlist[index % Math.max(playlist.length, 1)];

  useEffect(() => {
    setIndex(0);
  }, [appKey, includeBlank]);

  useEffect(() => {
    if (playlist.length < 2) return;
    const duration = active ? displayDurationSeconds : blankDurationSeconds;
    const id = window.setTimeout(() => setIndex((current) => (current + 1) % playlist.length), Math.max(0.5, duration) * 1000);
    return () => window.clearTimeout(id);
  }, [index, appKey, includeBlank, playlist.length, !!active, displayDurationSeconds, blankDurationSeconds]);

  if (!active) return <div className="h-full w-full bg-black" />;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-black px-[5vw]">
      <PlatformLogo key={`${active.id}-${index}`} platform={active} />
    </div>
  );
}

function PlatformLogo({ platform }: { platform: (typeof PLATFORMS)[number] }) {
  return (
    <div
      aria-label={platform.name}
      className="animate-platform-logo grid h-[72vmin] w-[72vmin] place-items-center"
      style={{
        background: platform.color,
        color: platform.text,
        borderRadius: "18%",
        boxShadow: `0 0 110px ${platform.accent}88`,
      }}
    >
      <span className="font-cond text-[15vh] font-bold tracking-[0.1em]">
        {platform.short}
      </span>
    </div>
  );
}

function WaitingFace({ pairCode }: { pairCode?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-black text-center text-cream">
      <ChevronMark className="h-10 w-10 text-amber animate-breathe" />
      <p className="mt-5 text-[11px] tracking-[0.48em] text-mist">WAITING FOR DRIVER PHONE</p>
      <p className="mt-3 font-cond text-[7vw] tracking-[0.25em] text-amber">{pairCode}</p>
      <p className="mt-5 max-w-sm text-xs text-mist">Keep this exact display page open. The selected logo appears as soon as the driver console connects.</p>
    </div>
  );
}

function SleepFace() {
  // Manual OFF is intentionally a blank OLED-black screen: no animation and no text.
  return <div className="h-full w-full bg-black" />;
}

function IncomingFace({
  ride,
  labels,
  platformName,
  accent,
  palette,
}: {
  ride: Ride;
  labels: ReturnType<typeof t>;
  platformName: string;
  accent: string;
  palette: Palette;
}) {
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden">
      <div className="animate-flood absolute inset-x-0 top-1/2 h-24 -translate-y-1/2" style={{ background: accent }} />
      <div className="scan-line pointer-events-none absolute inset-x-0 h-px bg-white/80" />
      <p className="relative text-[11px] tracking-[0.62em] opacity-80">{labels.incoming}</p>
      <p className="relative mt-4 font-cond text-[13vw] leading-none tracking-[0.2em]" style={{ color: accent === "#000000" ? palette.fg : accent }}>
        {platformName}
      </p>
      <p className="relative mt-6 font-display text-[10vw] uppercase">{ride.passengerFirst}</p>
    </div>
  );
}

function EnRouteFace({
  ride,
  settings,
  labels,
  palette,
  platform,
}: {
  ride: Ride;
  settings: DisplaySettings;
  labels: ReturnType<typeof t>;
  palette: Palette;
  platform: string;
}) {
  return (
    <div className="flex h-full w-full flex-col justify-between px-[4vw] py-[3.5vw]">
      <HeaderRow platform={settings.showPlatform ? platform : ""} color={ride.colorCode} showBar={settings.showColorBar} />
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <p className="mb-3 text-[11px] tracking-[0.55em] opacity-55">{labels.onTheWay}</p>
        <h1 className="display-name animate-name uppercase" style={{ fontSize: "clamp(64px, 18vw, 220px)" }}>
          {ride.passengerFirst}
        </h1>
        {settings.showLastInitial && ride.passengerLastInitial && (
          <p className="mt-2 font-cond text-[7vw] tracking-[0.4em] opacity-70">{ride.passengerLastInitial}.</p>
        )}
      </div>
      <FooterRow pin={settings.showPin ? ride.pin : ""} color={ride.colorCode} plateHint={palette.muted} />
    </div>
  );
}

function CountdownFace({
  ride,
  settings,
  motion,
  labels,
  palette,
}: {
  ride: Ride;
  settings: DisplaySettings;
  motion: MotionState;
  labels: ReturnType<typeof t>;
  palette: Palette;
}) {
  const remain = Math.max(0, settings.stopDelaySeconds - motion.stoppedForMs / 1000);
  const secs = Math.ceil(remain);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-[4vw]">
      <p className="text-[11px] tracking-[0.55em] opacity-55">{labels.arriving}</p>
      <h1 className="display-name mt-2 uppercase" style={{ fontSize: "clamp(48px, 14vw, 160px)" }}>
        {ride.passengerFirst}
      </h1>
      <div className="relative mt-6 grid h-28 w-28 place-items-center">
        <svg viewBox="0 0 96 96" className="absolute inset-0 h-full w-full -rotate-90">
          <circle cx="48" cy="48" r="42" fill="none" stroke={palette.line} strokeWidth="4" />
          <circle
            cx="48"
            cy="48"
            r="42"
            fill="none"
            stroke={ride.colorCode}
            strokeWidth="4"
            strokeDasharray="264"
            strokeDashoffset={264 * (remain / settings.stopDelaySeconds)}
            strokeLinecap="round"
          />
        </svg>
        <span className="font-cond text-5xl">{secs}</span>
      </div>
    </div>
  );
}

function ArrivedFace({
  ride,
  settings,
  labels,
  palette,
  platform,
}: {
  ride: Ride;
  settings: DisplaySettings;
  labels: ReturnType<typeof t>;
  palette: Palette;
  platform: string;
}) {
  return (
    <div className="relative flex h-full w-full flex-col">
      {settings.showColorBar && <div className="h-[2.2vh] w-full" style={{ background: ride.colorCode }} />}
      <div className="flex flex-1 flex-col items-center justify-center px-[3vw] text-center">
        {settings.showGreeting && (
          <p className="animate-breathe mb-2 font-cond text-[3.4vw] tracking-[0.55em]" style={{ color: ride.colorCode }}>
            {labels.yourRide}
          </p>
        )}
        <h1 className="display-name animate-name uppercase" style={{ fontSize: "clamp(80px, 24vw, 280px)" }}>
          {ride.passengerFirst}
        </h1>
        {settings.showLastInitial && ride.passengerLastInitial && (
          <p className="mt-1 font-cond text-[8vw] tracking-[0.42em] opacity-80">{ride.passengerLastInitial}.</p>
        )}
        <div className="mt-6 flex items-center gap-6">
          {settings.showPlatform && <span className="font-cond text-[3.2vw] tracking-[0.4em] opacity-70">{platform}</span>}
          {settings.showPin && ride.pin && (
            <span className="rounded-md border px-4 py-1 font-cond text-[4vw] tracking-[0.28em]" style={{ borderColor: palette.line }}>
              {ride.pin}
            </span>
          )}
        </div>
      </div>
      {settings.showColorBar && <div className="h-[2.2vh] w-full" style={{ background: ride.colorCode }} />}
    </div>
  );
}

function TripFace({ ride, labels, palette }: { ride: Ride; labels: ReturnType<typeof t>; palette: Palette }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-8 text-center">
      <ChevronMark className="mb-6 h-12 w-12 opacity-40" />
      <p className="text-[11px] tracking-[0.5em] opacity-50">{labels.inTrip}</p>
      <p className="mt-4 font-cond text-[6vw] tracking-wide">{ride.dropoff}</p>
      <p className="mt-6 text-sm opacity-40" style={{ color: palette.muted }}>
        {ride.fare}
      </p>
    </div>
  );
}

function ThanksFace({ labels, palette }: { labels: ReturnType<typeof t>; palette: Palette }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      <p className="font-display text-[10vw] tracking-[0.08em]">{labels.thanks}</p>
      <p className="mt-4 text-[11px] tracking-[0.5em] opacity-40" style={{ color: palette.muted }}>
        RETROFLEX
      </p>
    </div>
  );
}

function HeaderRow({ platform, color, showBar }: { platform: string; color: string; showBar: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-cond text-[2.6vw] tracking-[0.42em] opacity-70">{platform}</span>
      {showBar && <span className="h-3 w-16 rounded-full" style={{ background: color }} />}
    </div>
  );
}

function FooterRow({ pin, color, plateHint }: { pin: string; color: string; plateHint: string }) {
  return (
    <div className="flex items-end justify-between">
      <span className="text-[10px] tracking-[0.4em]" style={{ color: plateHint }}>
        RETROFLEX
      </span>
      <div className="flex items-center gap-3">
        {pin && <span className="font-cond text-[3vw] tracking-[0.3em]">{pin}</span>}
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      </div>
    </div>
  );
}

interface Palette {
  bg: string;
  fg: string;
  muted: string;
  line: string;
}

const palettes: Record<string, Palette> = {
  night: { bg: "#050505", fg: "#F4EDE1", muted: "#8a857c", line: "#2a2a2c" },
  day: { bg: "#F6F1E8", fg: "#111111", muted: "#6b675f", line: "#d7d0c4" },
  amber: { bg: "#120c04", fg: "#FFC44D", muted: "#a87a2a", line: "#3a2a10" },
};

export function DisplayPairGate({ onPaired, onBack }: { onPaired: (code: string) => void; onBack: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-ink px-6 text-cream">
      <ChevronMark className="mb-6 h-12 w-12 text-amber" />
      <p className="text-[11px] tracking-[0.5em] text-amber">TABLET DISPLAY</p>
      <h1 className="mt-3 font-display text-4xl">Enter pair code</h1>
      <p className="mt-2 max-w-sm text-center text-sm text-mist">Open the driver console on your phone and type the six-character code here.</p>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
        placeholder="7K2M9Q"
        className="mt-8 w-72 rounded-2xl border border-line bg-panel px-5 py-4 text-center font-cond text-4xl tracking-[0.35em] outline-none focus:border-amber"
      />
      <button
        onClick={() => {
          if (value.length !== 6) return;
          // This tap is a valid browser gesture, so prime fullscreen before opening the live rear display.
          enterDisplayFullscreen();
          onPaired(value);
        }}
        className="mt-6 w-72 rounded-2xl bg-amber py-3.5 font-semibold text-ink"
      >
        Arm display
      </button>
      <button onClick={onBack} className="mt-4 inline-flex items-center gap-2 text-sm text-mist">
        <RotateCcw className="h-3.5 w-3.5" /> Back
      </button>
      <p className="mt-10 text-[11px] tracking-widest text-mist/60">TURN ON FROM THE PHONE · STAYS AWAKE UNTIL YOU TURN IT OFF</p>
    </div>
  );
}

function enterDisplayFullscreen() {
  const el = document.documentElement;
  if (!el.requestFullscreen) return;
  void el.requestFullscreen()
    .then(() => {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (mode: "landscape" | "portrait") => Promise<void> };
      return orientation.lock?.("landscape");
    })
    .catch(() => undefined);
}

function getTabletDeviceId() {
  const key = "rf:tablet-device-id";
  const current = localStorage.getItem(key);
  if (current) return current;
  const next = `tab_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(key, next);
  return next;
}

function getTabletDeviceName() {
  const ua = navigator.userAgent;
  const android = ua.match(/Android[^;]*;\s*([^;)]+)/i)?.[1]?.trim();
  return android ? `Android · ${android}` : "Rear tablet";
}

export function useDisplayClock(active: boolean) {
  return useNow(active ? 1000 : 60000);
}
