import { useEffect, useState } from "react";
import { ArrowLeft, Power } from "lucide-react";
import { DisplaySettings } from "../types";
import { defaultSettings } from "../lib/storage";
import { PLATFORMS } from "../lib/platforms";
import { DisplayScreen } from "./DisplayScreen";
import { Logo } from "./Logo";

export function DemoStudio({ go }: { go: (p: string) => void }) {
  const [on, setOn] = useState(false);
  const [settings, setSettings] = useState<DisplaySettings>({ ...defaultSettings(), theme: "night", masterOn: false, apps: ["uber", "didi", "lyft"] });

  useEffect(() => {
    if (on !== settings.masterOn) {
      const id = window.setTimeout(() => setSettings((s) => ({ ...s, masterOn: on })), on ? 120 : 90);
      return () => window.clearTimeout(id);
    }
  }, [on]);

  return (
    <div className="min-h-dvh bg-ink text-cream">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <button onClick={() => go("/")} className="inline-flex items-center gap-2 text-sm text-mist hover:text-cream">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <Logo />
        <button onClick={() => setOn(!on)} className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm ${on ? "border-amber text-amber" : "border-line text-mist"}`}>
          <Power className="h-3.5 w-3.5" />
          {on ? "Switch OFF" : "Switch ON"}
        </button>
      </header>

      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-8 lg:grid-cols-[280px_1fr]">
        <aside className="order-2 lg:order-1">
          <p className="text-[11px] tracking-[0.4em] text-amber">STUDIO</p>
          <h1 className="mt-2 font-display text-3xl">Switch ON/OFF the rear glass.</h1>
          <p className="mt-3 text-sm text-mist">
            {on
              ? "The tablet is awake and bright. Your rideshare apps (and any you pick) are lit on the rear window."
              : "The tablet is asleep — a black, idle rectangle that frees its resources until you switch it back on."}
          </p>
          <div className="mt-6 rounded-2xl border border-line bg-panel p-4">
            <p className="text-[11px] tracking-[0.26em] text-amber">APPS ON GLASS</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {PLATFORMS.map((p) => {
                const chosen = settings.apps?.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      const apps = chosen ? (settings.apps ?? []).filter((x) => x !== p.id) : [...(settings.apps ?? []), p.id];
                      setSettings((s) => ({ ...s, apps }));
                    }}
                    className={`rounded-full px-3 py-1.5 text-xs ${chosen ? "bg-amber text-ink" : "bg-ink text-mist"}`}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
          <button onClick={() => go("/lab")} className="mt-8 w-full rounded-2xl bg-cream py-3 font-semibold text-ink">
            Try the paired lab
          </button>
        </aside>

        <div className="order-1 space-y-6 lg:order-2">
          <div>
            <p className="mb-2 text-[11px] tracking-[0.35em] text-mist">REAR WINDOW · LANDSCAPE TABLET</p>
            <div className="tablet-frame overflow-hidden bg-black">
              <div className="aspect-[16/9]">
                <DisplayScreen settings={settings} powered={!!settings.masterOn} preview ride={null} />
              </div>
            </div>
          </div>
          <div className="rounded-3xl border border-line bg-panel p-6 text-sm leading-relaxed text-mist">
            Flip the switch. The tablet is a different device — in a real car it hangs on the rear glass and follows the phone over the pair channel. No customer names. Just your rideshare apps, on or off. OFF means idle black and free resources; ON wakes it and lights the apps you choose.
          </div>
        </div>
      </div>
    </div>
  );
}
