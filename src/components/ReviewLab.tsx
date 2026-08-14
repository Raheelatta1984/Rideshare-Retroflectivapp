import { useEffect, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Power, Smartphone, Tablet } from "lucide-react";
import { useStore } from "../store";
import { DisplayScreen } from "./DisplayScreen";
import { Logo } from "./Logo";
import { PLATFORMS } from "../lib/platforms";
import { usePairChannel } from "../lib/sync";
import type { Platform } from "../types";

export function ReviewLab({ go }: { go: (p: string) => void }) {
  const { ready, driver, bootDemo, powered, setPowered, settings, saveSettings, updateDriver } = useStore();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (ready && !driver) bootDemo();
  }, [ready, driver, bootDemo]);

  const origin = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "";
  const tabletBase = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "/";
  const tabletUrl = `${tabletBase}?mode=tablet&display=${driver?.pairCode ?? "7K2M9Q"}`;
  const phoneUrl = `${origin}#/app`;

  const apps = driver?.platforms?.length ? PLATFORMS.filter((p) => driver.platforms.includes(p.id)) : PLATFORMS;
  const { publish, connected } = usePairChannel(driver?.pairCode, "host", () => {
    /* The review lab is also a real driver host for a paired tablet. */
  });

  useEffect(() => {
    if (!driver) return;
    publish({
      type: "settings",
      settings: { ...settings, masterOn: powered, apps: apps.map((app) => app.id) },
      ride: null,
    });
  }, [driver?.pairCode, driver?.platforms, powered, settings, apps]);

  const togglePlatform = (platform: Platform) => {
    if (!driver) return;
    const selected = driver.platforms.includes(platform);
    if (selected && driver.platforms.length === 1) return;
    updateDriver({
      platforms: selected ? driver.platforms.filter((id) => id !== platform) : [...driver.platforms, platform],
    });
  };

  return (
    <div className="min-h-dvh bg-ink text-cream">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 md:px-6">
        <button onClick={() => go("/")} className="inline-flex items-center gap-2 text-sm text-mist hover:text-cream">
          <ArrowLeft className="h-4 w-4" /> Home
        </button>
        <Logo />
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => go("/login")} className="rounded-full bg-amber px-3 py-1.5 text-xs font-semibold text-ink">
            Full driver booth
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 py-6 xl:grid-cols-[280px_1fr]">
        <aside className="space-y-5">
          <div>
            <p className="text-[11px] tracking-[0.4em] text-amber">REVIEW LAB</p>
            <h1 className="mt-2 font-display text-3xl leading-none">Phone ON/OFF. Glass follows.</h1>
            <p className="mt-3 text-sm leading-relaxed text-mist">
              Left is the driver phone with one big switch. Right is the tablet on the rear window. Flip the switch and the whole glass turns on or off. No customer names — just your rideshare apps.
            </p>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-4">
            <p className="text-[11px] tracking-[0.26em] text-amber">STEPS</p>
            <ol className="mt-3 space-y-2 text-sm text-mist">
              <li>1. Flip <b className="text-cream">ON</b> → the tablet wakes and its screen lights up with your rideshare tiles.</li>
              <li>2. The phone shows the same apps. Tap one to pick which app is live.</li>
              <li>3. Flip <b className="text-cream">OFF</b> → the tablet drops to idle black and frees resources.</li>
            </ol>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-4 text-sm">
            <p className="text-[11px] tracking-[0.28em] text-amber">TWO REAL DEVICES</p>
            <p className="mt-2 text-mist">Phone browser → driver booth. Tablet browser → display link.</p>
            <p className={`mt-2 text-[11px] tracking-[0.2em] ${connected ? "text-amber" : "text-mist"}`}>
              {connected ? "TABLET CONNECTED" : "WAITING FOR TABLET"}
            </p>
            <div className="mt-3 space-y-2 text-xs">
              <LinkRow label="Phone" value={phoneUrl} />
              <LinkRow label="Tablet" value={tabletUrl} />
            </div>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(tabletUrl);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }}
              className="mt-3 inline-flex items-center gap-2 text-xs text-cream"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-amber" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Tablet link copied" : "Copy tablet link"}
            </button>
          </div>
        </aside>

        <div className="space-y-5">
          {/* Master switch */}
          <button
            onClick={() => setPowered(!powered)}
            className={`flex w-full items-center justify-between rounded-3xl border-2 px-6 py-6 text-left transition-colors ${
              powered ? "border-amber bg-amber/15" : "border-line bg-panel"
            }`}
          >
            <div className="flex items-center gap-4">
              <span className={`grid h-14 w-14 place-items-center rounded-2xl ${powered ? "bg-amber text-ink" : "bg-ink text-mist"}`}>
                <Power className="h-7 w-7" />
              </span>
              <div>
                <div className={`text-3xl font-semibold ${powered ? "text-amber" : "text-mist"}`}>{powered ? "ON" : "OFF"}</div>
                <div className="mt-1 text-sm text-mist">{powered ? "Rear glass lit + live" : "Rear glass idle, asleep"}</div>
              </div>
            </div>
            <span className={`relative h-9 w-16 rounded-full transition-colors ${powered ? "bg-amber" : "bg-ink"}`}>
              <span className={`absolute top-1 h-7 w-7 rounded-full bg-cream transition-all ${powered ? "left-8" : "left-1"}`} />
            </span>
          </button>

          <div className="flex flex-wrap gap-2">
            <button onClick={() => setPowered(true)} className={`rounded-full px-3 py-1.5 text-xs ${powered ? "bg-amber text-ink" : "border border-line text-mist"}`}>
              Turn ON
            </button>
            <button onClick={() => setPowered(false)} className={`rounded-full px-3 py-1.5 text-xs ${!powered ? "bg-amber text-ink" : "border border-line text-mist"}`}>
              Turn OFF
            </button>
            <span className="mx-2 text-xs text-mist">Theme</span>
            {(["night", "day", "amber"] as const).map((th) => (
              <button
                key={th}
                onClick={() => saveSettings({ theme: th })}
                className={`rounded-full px-3 py-1 uppercase tracking-widest ${settings.theme === th ? "bg-cream text-ink" : "bg-panel text-mist"}`}
              >
                {th}
              </button>
            ))}
          </div>

          <div className="grid items-start gap-6 lg:grid-cols-[280px_1fr]">
            <div>
              <p className="mb-2 flex items-center gap-2 text-[11px] tracking-[0.35em] text-mist">
                <Smartphone className="h-3.5 w-3.5" /> DRIVER PHONE
              </p>
              <div className="phone-frame bg-black p-2">
                <PhoneMock
                  powered={powered}
                  setPowered={setPowered}
                  pair={driver?.pairCode ?? "7K2M9Q"}
                  apps={apps}
                  onToggle={togglePlatform}
                />
              </div>
            </div>

            <div>
              <p className="mb-2 flex items-center gap-2 text-[11px] tracking-[0.35em] text-mist">
                <Tablet className="h-3.5 w-3.5" /> REAR WINDOW TABLET
              </p>
              <div className="tablet-frame overflow-hidden bg-black">
                <div className="aspect-[16/9]">
                  <DisplayScreen
                    settings={{ ...settings, apps: apps.map((app) => app.id) }}
                    powered={powered}
                    preview
                    ride={null}
                  />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-mist">
                <span>Pair code {driver?.pairCode ?? "7K2M9Q"} · stays awake while ON</span>
                <span className="inline-flex items-center gap-1">
                  {powered ? "AWAKE · SHOWING APPS" : "IDLE · BLACK"}
                </span>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {PLATFORMS.map((p) => {
              const selected = !!driver?.platforms.includes(p.id);
              return (
              <button
                key={p.id}
                onClick={() => togglePlatform(p.id)}
                className={`rounded-2xl border px-4 py-3 text-left ${selected ? "border-amber bg-amber/10" : "border-line bg-panel opacity-50"}`}
              >
                <span
                  className="inline-grid h-9 w-9 place-items-center rounded-xl font-cond text-xs"
                  style={{ background: p.color, color: p.text }}
                >
                  {p.short.slice(0, 2)}
                </span>
                <p className="mt-2 font-medium">{p.name}</p>
                <p className="text-xs text-mist">{selected ? "Shown on rear glass" : "Tap to select"}</p>
              </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function LinkRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-12 shrink-0 tracking-widest text-mist">{label}</span>
      <a href={value} className="break-all text-cream/80 hover:text-amber">
        {value} <ExternalLink className="inline h-3 w-3" />
      </a>
    </div>
  );
}

function PhoneMock({
  powered,
  setPowered,
  pair,
  apps,
  onToggle,
}: {
  powered: boolean;
  setPowered: (on: boolean) => void;
  pair: string;
  apps: Array<(typeof PLATFORMS)[number]>;
  onToggle: (platform: Platform) => void;
}) {
  return (
    <div className="rounded-[1.7rem] bg-ink px-3 py-4 text-cream">
      <p className="text-[10px] tracking-[0.32em] text-mist">RETROFLEX · REMOTE</p>
      <button
        onClick={() => setPowered(!powered)}
        className={`mt-3 flex w-full items-center justify-between rounded-2xl border-2 px-4 py-4 ${powered ? "border-amber bg-amber/15" : "border-line bg-panel"}`}
      >
        <div className="flex items-center gap-2">
          <Power className={`h-5 w-5 ${powered ? "text-amber" : "text-mist"}`} />
          <span className={`text-xl font-bold ${powered ? "text-amber" : "text-mist"}`}>{powered ? "ON" : "OFF"}</span>
        </div>
        <span className={`relative h-7 w-13 rounded-full transition-colors ${powered ? "bg-amber" : "bg-ink"}`}>
          <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-cream transition-all ${powered ? "left-6" : "left-0.5"}`} />
        </span>
      </button>
      <p className="mt-4 text-[10px] tracking-[0.3em] text-mist">APPS ON GLASS</p>
      <div className="mt-2 space-y-1.5">
        {apps.map((p) => (
          <button key={p.id} onClick={() => onToggle(p.id)} className="flex w-full items-center gap-2 rounded-xl border border-amber/30 bg-panel px-3 py-2 text-left">
            <span className="h-5 w-5 rounded-md" style={{ background: p.color }} />
            <span className="text-xs">{p.name}</span>
          </button>
        ))}
      </div>
      <p className="mt-4 text-center text-[10px] tracking-[0.28em] text-mist">PAIR {pair}</p>
    </div>
  );
}
