import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Battery, BatteryCharging, Maximize, RotateCcw } from "lucide-react";
import type { CommercialCampaign, DeviceTelemetry, DisplaySettings, MotionState, Ride, TabletBattery } from "../types";
import { db, defaultSettings } from "../lib/storage";
import { PLATFORMS, getPlatform } from "../lib/platforms";
import { getBackend } from "../lib/backend";
import { EventQueue } from "../lib/backend/queue";
import {
  buildPlaylist,
  campaignBrightness,
  campaignAssetSrc,
  isSafeAssetUrl,
  effectiveMediaType,
  campaignRunsUnregulated,
  legalPackIsEnabled,
  selectCampaigns,
  slideDurationSeconds,
} from "../lib/signage";
import { profileForDevice } from "../lib/devices";
import { t } from "../lib/i18n";
import { usePairChannel } from "../lib/sync";
import { useMotion } from "../lib/motion";
import { requestWakeLock, useNow } from "../hooks";
import { ChevronMark } from "./Logo";
import { uid } from "../lib/id";

interface Props {
  pairCode?: string;
  position?: "rear" | "front";
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

export function DisplayScreen({ pairCode, position = "rear", ride: rideProp, settings: settingsProp, powered: poweredProp, preview, demoStopped, onExit }: Props) {
  const [remoteRide, setRemoteRide] = useState<Ride | null>(null);
  const [remoteSettings, setRemoteSettings] = useState<DisplaySettings>(defaultSettings());
  const [remoteMotion, setRemoteMotion] = useState<MotionState | null>(null);
  const [taps, setTaps] = useState(0);
  // null = the current slide is not a campaign, so no extra brightness cap applies.
  const [activeBrightnessCap, setActiveBrightnessCap] = useState<number | null>(null);
  const [tabletBattery, setTabletBattery] = useState<TabletBattery | null>(null);
  const [localTelemetry, setLocalTelemetry] = useState<DeviceTelemetry | null>(null);
  const [flash, setFlash] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasRemoteSync, setHasRemoteSync] = useState(false);
  const [activeContent, setActiveContent] = useState("blank");
  const rootRef = useRef<HTMLDivElement>(null);
  const lastStatus = useRef<string>("idle");
  const lastSafetyStateRef = useRef<"live" | "blank" | null>(null);
  const deviceIdRef = useRef(getTabletDeviceId());
  const mountedAtRef = useRef(Date.now());
  const lastCommandRef = useRef("");
  const lastBatteryLogRef = useRef<number | null>(null);
  const lastTelemetryLogRef = useRef(0);

  const { publish } = usePairChannel(pairCode, "display", (packet) => {
    if (packet.targetDeviceId && packet.targetDeviceId !== deviceIdRef.current) return;
    if (packet.ride !== undefined) setRemoteRide(packet.ride ?? null);
    if (packet.motion) setRemoteMotion(packet.motion);
    if (packet.settings) {
      setRemoteSettings(packet.settings);
      setHasRemoteSync(true);
      const signature = JSON.stringify({
        powered: packet.settings.masterOn,
        apps: packet.settings.apps,
        brightness: packet.settings.brightness,
        seconds: packet.settings.displayDurationSeconds,
        blank: packet.settings.includeBlank,
      });
      if (pairCode && signature !== lastCommandRef.current) {
        lastCommandRef.current = signature;
        db.addTabletActivity({
          id: uid("tablog"),
          at: Date.now(),
          pairCode,
          deviceId: deviceIdRef.current,
          action: "Driver display command received",
          details: {
            powered: packet.settings.masterOn ?? false,
            platforms: packet.settings.apps?.join(", ") ?? "blank",
            brightness: packet.settings.brightness,
            logoSeconds: packet.settings.displayDurationSeconds,
          },
        });
      }
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
        name: getTabletDeviceName(position),
        pairCode,
        position,
        lastSeen: Date.now(),
      },
    });
    hello();
    const interval = window.setInterval(hello, 8000);
    return () => window.clearInterval(interval);
  }, [pairCode, preview, position]);

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
        name: getTabletDeviceName(position),
        pairCode: pairCode ?? "",
        position,
        lastSeen: Date.now(),
      }, pairCode ?? "", position)
    : null;
  // Central power must be ON, then each tablet's own profile controls its display.
  const centralPowered = poweredProp !== undefined ? poweredProp : settings.masterOn !== false;
  const powered = centralPowered && (deviceProfile?.powered ?? true);
  // Platform *ids* — resolved to PLATFORMS entries further down.
  const apps: string[] = deviceProfile?.apps?.length ? deviceProfile.apps : settings.apps?.length ? settings.apps : ["didi"];
  const commercialEnabled = deviceProfile?.commercialEnabled ?? false;
  const campaignIds = deviceProfile?.campaignIds ?? [];
  // Only campaigns assigned to this device, inside their schedule window, with a
  // usable asset and complete consents. The engine reports *why* one is blocked.
  const campaigns = selectCampaigns(
    (settings.commercialCampaigns ?? []).filter((campaign) => campaignIds.includes(campaign.id)),
    {
      nswSafetyMode: settings.nswSafetyMode ?? true,
      legalPackEnabled: legalPackIsEnabled(settings),
      position,
      parkedConfirmed: deviceProfile?.commercialParkedConfirmed,
    },
  );
  // Anything on this glass that is running outside the legal pack gets marked.
  const unregulatedOnGlass = campaigns.some((campaign) => campaignRunsUnregulated(campaign, settings));
  const motionGps = useMotion(!preview && !!ride && powered && ["en_route", "stopped"].includes(ride.status), demoStopped, settings.stationarySpeedKph ?? 0.5);
  // The driver's phone is the movement authority. Tablet GPS is only a legacy fallback for ride demos.
  const motion: MotionState = remoteMotion ?? motionGps;

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
        deviceName: getTabletDeviceName(position),
        pairCode,
        position,
      };
      setTabletBattery(next);
      const previous = lastBatteryLogRef.current;
      if (pairCode && (previous == null || previous !== next.percentage)) {
        lastBatteryLogRef.current = next.percentage;
        db.addTabletActivity({
          id: uid("tablog"),
          at: next.updatedAt,
          pairCode,
          deviceId: deviceIdRef.current,
          action: "Battery update",
          details: { battery: next.percentage, charging: next.charging },
        });
      }
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
    if (motion.isStationary && motion.stoppedForMs >= (settings.stopDelaySeconds ?? 30) * 1000) {
      publish({ type: "motion", motion, ride: { ...ride, status: "arrived", arrivedAt: new Date().toISOString() } });
    }
  }, [motion.stoppedForMs, motion.isStationary, ride?.status, settings.stopDelaySeconds, pairCode]);

  const hour = new Date().getHours();
  const theme = settings.theme === "auto" ? (hour >= 6 && hour < 18 ? "day" : "night") : settings.theme;
  const palette = palettes[theme];
  const platform = ride ? getPlatform(ride.platform) : null;
  const labels = t(settings.language);
  const status = ride?.status ?? "idle";
  const motionGate = settings.motionSafetyGate ?? true;
  const stationaryWaitMs = (settings.stationaryWaitSeconds ?? 60) * 1000;
  const motionAllowed = preview || !motionGate || (motion.allowed && motion.isStationary && motion.stoppedForMs >= stationaryWaitMs);
  // Moving/unknown motion is intentionally the same pure black low-power screen as OFF.
  const sleeping = !powered || status === "complete" || !motionAllowed;
  const showApps = powered && motionAllowed && (!ride || status === "idle");
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
  const baseBrightness = Math.max(18, daylightBrightness * batteryFactor);
  // A campaign may lower brightness further (plan: day/night + per-campaign caps).
  const brightness = campaignBrightness(baseBrightness, {
    campaign: activeBrightnessCap === null ? undefined : { brightnessCap: activeBrightnessCap },
    isNight: !daylight,
  }) / 100;
  const telemetrySignature = `${powered}|${apps.join(",")}|${brightness}|${deviceProfile?.displayDurationSeconds ?? settings.displayDurationSeconds ?? 4.5}|${deviceProfile?.includeBlank ?? settings.includeBlank ?? false}`;

  // Phase 2: proof-of-play goes to the Event API (queued + retried off-network).
  const eventQueueRef = useRef<EventQueue | null>(null);
  if (!eventQueueRef.current) {
    eventQueueRef.current = new EventQueue({ backend: getBackend(), flushMs: 20000, batchSize: 10 });
  }
  useEffect(() => () => eventQueueRef.current?.stop(), []);

  const handlePlaylistEvent = useCallback((event: { kind: "platform" | "campaign" | "blank"; title: string; id?: string; brightnessCap?: number }) => {
    setActiveContent(event.title);
    // null = no campaign on screen, so no extra cap applies.
    setActiveBrightnessCap(event.kind === "campaign" ? (event.brightnessCap ?? 100) : null);
    if (!pairCode || preview || event.kind !== "campaign") return;
    const activity = {
      id: uid("tablog"),
      at: Date.now(),
      pairCode,
      deviceId: deviceIdRef.current,
      action: "Commercial campaign displayed",
      details: { campaign: event.title, campaignId: event.id, nswSafetyMode: settings.nswSafetyMode ?? true },
    };
    db.addTabletActivity(activity);
    publishRef.current({ type: "activity", activity });

    // Phase 2 Event API: proof-of-play for the campaign portal + billing evidence.
    eventQueueRef.current?.proofOfPlay({
      campaignId: event.id ?? event.title,
      deviceId: deviceIdRef.current,
      pairCode,
      title: event.title,
    });

    // Event API: proof-of-play for the campaign portal + billing evidence.
    eventQueueRef.current?.proofOfPlay({
      campaignId: event.id ?? event.title,
      deviceId: deviceIdRef.current,
      pairCode,
      title: event.title,
    });
  }, [pairCode, preview, settings.nswSafetyMode, position]);

  useEffect(() => {
    const nextState: "live" | "blank" = sleeping ? "blank" : "live";
    if (nextState === lastSafetyStateRef.current) return;
    lastSafetyStateRef.current = nextState;
    setActiveContent(nextState === "blank" ? "blank" : activeContent);
    if (!pairCode || preview) return;
    const action = nextState === "blank" && motionGate && powered
      ? "Motion safety gate blanked display"
      : nextState === "live" && motionGate
        ? "Motion safety gate released display"
        : nextState === "blank"
          ? "Display blanked"
          : "Display activated";
    const activity = {
      id: uid("tablog"),
      at: Date.now(),
      pairCode,
      deviceId: deviceIdRef.current,
      action,
      details: { speedKph: motion.speedMps == null ? undefined : Number((motion.speedMps * 3.6).toFixed(1)), stoppedSeconds: Math.floor(motion.stoppedForMs / 1000), gateEnabled: motionGate },
    };
    db.addTabletActivity(activity);
    publishRef.current({ type: "activity", activity });
  }, [sleeping, powered, motionGate, motion.speedMps, motion.stoppedForMs, pairCode, preview]);

  useEffect(() => {
    if (!pairCode || preview) return;
    const report = () => {
      const telemetry = getDeviceTelemetry({
        pairCode,
        position,
        deviceId: deviceIdRef.current,
        deviceName: getTabletDeviceName(position),
        battery: tabletBattery,
        displayState: powered && motionAllowed ? "live" : "blank",
        mountedAt: mountedAtRef.current,
        activeContent,
      });
      setLocalTelemetry(telemetry);
      if (Date.now() - lastTelemetryLogRef.current >= 60_000) {
        lastTelemetryLogRef.current = Date.now();
        db.addTabletActivity({
          id: uid("tablog"),
          at: telemetry.at,
          pairCode,
          deviceId: deviceIdRef.current,
          action: "Telemetry heartbeat",
          details: { state: telemetry.displayState, screen: telemetry.screen, network: telemetry.connection, battery: telemetry.battery?.percentage, heapMb: telemetry.jsHeapUsedMb },
        });
      }
      publishRef.current({ type: "telemetry", telemetry });
    };
    report();
    const id = window.setInterval(report, 10_000);
    return () => window.clearInterval(id);
  }, [pairCode, position, preview, powered, tabletBattery?.percentage, tabletBattery?.charging, telemetrySignature, activeContent]);

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
          campaigns={campaigns}
          commercialEnabled={commercialEnabled}
          nswSafetyMode={settings.nswSafetyMode ?? true}
          backgroundMode={settings.platformBackgroundMode ?? "brand"}
          wordmarkEmbossed={settings.wordmarkEmbossed ?? true}
          fadeTransitions={!!settings.fadeTransitions && !(settings.nswSafetyMode ?? true)}
          onActiveItem={handlePlaylistEvent}
          passengerName={position === "front" && deviceProfile?.passengerNameEnabled ? deviceProfile.passengerName : undefined}
          displayDurationSeconds={deviceProfile?.displayDurationSeconds ?? settings.displayDurationSeconds ?? 4.5}
          includeBlank={deviceProfile?.includeBlank ?? settings.includeBlank ?? false}
          blankDurationSeconds={deviceProfile?.blankDurationSeconds ?? settings.blankDurationSeconds ?? 1.5}
          speedKph={motion.isStationary ? 0 : (motion.speedMps ?? 0) * 3.6}
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

      {(settings.unregulatedBadge ?? true) && !sleeping && unregulatedOnGlass && (
        <div className="pointer-events-none absolute top-3 right-3 z-10 rounded border border-amber/50 bg-black/65 px-2 py-1 text-[9px] leading-tight tracking-[0.18em] text-amber">
          <p>TEST · NO LEGAL PACK</p>
          <p className="text-white/60">consents + approval not enforced</p>
        </div>
      )}

      {!preview && !sleeping && settings.diagnosticsOverlay && localTelemetry && (
        <div className="pointer-events-none absolute top-3 left-3 z-10 max-w-[45vw] rounded bg-black/55 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-white/80">
          <p>{localTelemetry.screen} · DPR {localTelemetry.devicePixelRatio}</p>
          <p>{localTelemetry.connection ?? "network n/a"}{localTelemetry.rttMs ? ` · ${localTelemetry.rttMs}ms` : ""}</p>
          <p>heap {localTelemetry.jsHeapUsedMb ? `${localTelemetry.jsHeapUsedMb}MB` : "n/a"} · up {formatTelemetryUptime(localTelemetry.uptimeSeconds)}</p>
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
          <Maximize className="h-3 w-3" /> TAP {5 - taps} MORE FOR DEVICE LOG
        </div>
      )}
    </div>
  );
}

function AppsFace({
  apps,
  campaigns,
  commercialEnabled,
  nswSafetyMode,
  backgroundMode,
  wordmarkEmbossed,
  fadeTransitions,
  onActiveItem,
  passengerName,
  displayDurationSeconds,
  includeBlank,
  blankDurationSeconds,
  speedKph = 0,
}: {
  apps: string[];
  campaigns: CommercialCampaign[];
  commercialEnabled: boolean;
  nswSafetyMode: boolean;
  backgroundMode: "brand" | "black";
  wordmarkEmbossed: boolean;
  fadeTransitions: boolean;
  onActiveItem: (event: { kind: "platform" | "campaign" | "blank"; title: string; id?: string; brightnessCap?: number }) => void;
  passengerName?: string;
  displayDurationSeconds: number;
  includeBlank: boolean;
  blankDurationSeconds: number;
  /** Current speed, used for the NSW dwell floor. */
  speedKph?: number;
}) {
  const appKey = apps.join("|");
  const visible = useMemo(
    () => apps.map((id) => PLATFORMS.find((p) => p.id === id)).filter(Boolean) as Array<(typeof PLATFORMS)[number]>,
    [appKey],
  );
  const [index, setIndex] = useState(0);

  // Plan order: platform logo → blank → campaign → blank (blanks are the
  // OLED-black low-power intervals and collapse when there is nothing between them).
  const playlist = useMemo(
    () =>
      buildPlaylist({
        platforms: visible,
        campaigns,
        commercialEnabled,
        nswSafetyMode,
        includeBlank,
      }),
    [appKey, campaigns, commercialEnabled, nswSafetyMode, includeBlank],
  );
  const active = playlist[index % Math.max(playlist.length, 1)];

  useEffect(() => {
    if (!active) {
      onActiveItem({ kind: "blank", title: "Blank frame" });
      return;
    }
    if (active.kind === "campaign") {
      onActiveItem({
        kind: "campaign",
        title: active.campaign.title,
        id: active.campaign.id,
        brightnessCap: active.campaign.brightnessCap,
      });
      return;
    }
    onActiveItem({
      kind: "platform",
      title: active.kind === "platform" ? active.platform.name : "",
      id: active.kind === "platform" ? active.platform.id : undefined,
    });
  }, [index, active?.kind, active?.kind === "campaign" ? active.campaign.id : active?.kind === "platform" ? active.platform.id : "", onActiveItem]);

  useEffect(() => {
    setIndex(0);
  }, [appKey, includeBlank]);

  useEffect(() => {
    if (playlist.length < 2) return;
    const duration = slideDurationSeconds(active, {
      platformSeconds: displayDurationSeconds,
      blankSeconds: blankDurationSeconds,
      nswSafetyMode,
      speedKph,
    });
    const id = window.setTimeout(() => setIndex((current) => (current + 1) % playlist.length), duration * 1000);
    return () => window.clearTimeout(id);
  }, [index, appKey, includeBlank, playlist.length, !!active, displayDurationSeconds, blankDurationSeconds, nswSafetyMode, speedKph]);

  if (!active || active.kind === "blank") return <div className="h-full w-full bg-black" />;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 items-center justify-center overflow-hidden bg-black">
      {active.kind === "platform" ? <PlatformLogo key={`${active.platform.id}-${index}`} platform={active.platform} backgroundMode={backgroundMode} embossed={wordmarkEmbossed} fade={fadeTransitions} passengerName={passengerName} /> : <CampaignSlide key={`${active.campaign.id}-${index}`} campaign={active.campaign} nswSafetyMode={nswSafetyMode} fade={fadeTransitions} />}
    </div>
  );
}

function CampaignSlide({ campaign, nswSafetyMode, fade }: { campaign: CommercialCampaign; nswSafetyMode: boolean; fade: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = campaignAssetSrc(campaign);
  const media = effectiveMediaType(campaign, nswSafetyMode);

  // Plan: "a black default image on failure". A campaign with no usable asset,
  // a rejected asset URL or a failed load renders the black frame instead of a
  // browser error icon.
  if (!src || !isSafeAssetUrl(src) || failed) {
    return <div role="img" aria-label={`${campaign.title} unavailable`} className="h-full w-full bg-black" />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {media === "image" || media === "gif" ? (
        <img
          src={src}
          alt={campaign.title}
          onError={() => setFailed(true)}
          className={`h-full w-full object-cover ${fade ? "animate-display-fade" : ""}`}
        />
      ) : (
        <video src={src} onError={() => setFailed(true)} className={`h-full w-full object-cover ${fade ? "animate-display-fade" : ""}`} muted autoPlay loop playsInline />
      )}
      {!nswSafetyMode && (campaign.discountText || campaign.referralCode) && (
        <div className="absolute inset-x-0 bottom-0 bg-black/65 px-[4vw] py-[2vh] text-center text-cream">
          {campaign.discountText && <p className="font-cond text-[4vh] font-bold">{campaign.discountText}</p>}
          {campaign.referralCode && <p className="mt-1 text-[2vh] tracking-[0.24em]">CODE {campaign.referralCode}</p>}
        </div>
      )}
    </div>
  );
}

function PlatformLogo({ platform, backgroundMode, embossed, fade, passengerName }: { platform: (typeof PLATFORMS)[number]; backgroundMode: "brand" | "black"; embossed: boolean; fade: boolean; passengerName?: string }) {
  const wordmark = platformWordmark(platform);
  const background = backgroundMode === "black" ? "#000000" : platform.color;
  const foreground = backgroundMode === "black" ? "#ffffff" : platform.text;
  return (
    <div
      aria-label={platform.name}
      className={`${fade ? "animate-display-fade" : ""} grid h-full min-h-0 w-full min-w-0 place-items-center overflow-hidden`}
      style={{
        background,
        color: foreground,
      }}
    >
      <svg
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full"
        role="img"
        aria-label={`${platform.name} platform logo`}
      >
        <defs>
          <filter id={`shadow-${platform.id}`} x="-20%" y="-30%" width="140%" height="160%">
            <feDropShadow dx="0" dy="20" stdDeviation="18" floodColor="#000000" floodOpacity={embossed ? "0.65" : "0.24"} />
          </filter>
        </defs>
        <g filter={`url(#shadow-${platform.id})`}>
          {embossed && <text
            x="800"
            y="520"
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#000000"
            opacity="0.48"
            fontFamily="Arial Black, Arial, sans-serif"
            fontSize={wordmark.length > 8 ? 176 : wordmark.length > 5 ? 238 : 300}
            fontWeight="900"
            letterSpacing={wordmark.length > 8 ? "-6" : "-10"}
          >{wordmark}</text>}
          <text
            x="800"
            y={embossed ? "502" : "510"}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={foreground}
            fontFamily="Arial Black, Arial, sans-serif"
            fontSize={wordmark.length > 8 ? 176 : wordmark.length > 5 ? 238 : 300}
            fontWeight="900"
            letterSpacing={wordmark.length > 8 ? "-6" : "-10"}
          >
            {wordmark}
          </text>
          {passengerName && <text x="800" y="700" textAnchor="middle" fill={foreground} opacity="0.88" fontFamily="Arial, sans-serif" fontSize="74" fontWeight="600" letterSpacing="6">{passengerName.toUpperCase()}</text>}
        </g>
      </svg>
    </div>
  );
}

function platformWordmark(platform: (typeof PLATFORMS)[number]) {
  const marks: Record<string, string> = {
    didi: "DiDi",
    indrive: "inDrive",
    freenow: "FREE NOW",
    ubereats: "Uber Eats",
    doordash: "DoorDash",
    deliveroo: "deliveroo",
    foodpanda: "foodpanda",
    justeat: "Just Eat",
  };
  return marks[platform.id] ?? platform.name;
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
      <HeaderRow platform={settings.showPlatform ? platform : ""} color={ride.colorCode} showBar={settings.showColorBar ?? true} />
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
  const remain = Math.max(0, (settings.stopDelaySeconds ?? 30) - motion.stoppedForMs / 1000);
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
            strokeDashoffset={264 * (remain / (settings.stopDelaySeconds ?? 30))}
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

function getTabletDeviceName(position: "rear" | "front" = "rear") {
  const ua = navigator.userAgent;
  const android = ua.match(/Android[^;]*;\s*([^;)]+)/i)?.[1]?.trim();
  const label = position === "front" ? "Front tablet" : "Rear tablet";
  return android ? `${label} · Android ${android}` : label;
}

function getDeviceTelemetry(input: {
  pairCode: string;
  position: "rear" | "front";
  deviceId: string;
  deviceName: string;
  battery: TabletBattery | null;
  displayState: "live" | "blank" | "waiting";
  mountedAt: number;
  activeContent?: string;
}): DeviceTelemetry {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; downlink?: number; rtt?: number };
  };
  const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
  return {
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    pairCode: input.pairCode,
    position: input.position,
    at: Date.now(),
    displayState: input.displayState,
    battery: input.battery ?? undefined,
    screen: `${window.screen.width}×${window.screen.height}`,
    devicePixelRatio: window.devicePixelRatio,
    visibility: document.visibilityState === "visible" ? "visible" : "hidden",
    connection: nav.connection?.effectiveType,
    downlinkMbps: nav.connection?.downlink,
    rttMs: nav.connection?.rtt,
    deviceMemoryGb: nav.deviceMemory,
    jsHeapUsedMb: perf.memory?.usedJSHeapSize ? Math.round(perf.memory.usedJSHeapSize / 1024 / 1024) : undefined,
    uptimeSeconds: Math.round((Date.now() - input.mountedAt) / 1000),
    activeContent: input.activeContent,
  };
}

function formatTelemetryUptime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m${remainder}s` : `${remainder}s`;
}

export function useDisplayClock(active: boolean) {
  return useNow(active ? 1000 : 60000);
}
