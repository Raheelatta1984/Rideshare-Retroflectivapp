import { useState } from "react";
import { Logo } from "./Logo";
import { useStore } from "../store";
import { PLATFORMS } from "../lib/platforms";
import type { Platform } from "../types";

export function Onboarding({ go }: { go: (p: string) => void }) {
  const { driver, updateDriver, updateVehicle } = useStore();
  const [step, setStep] = useState(0);
  const v = driver?.vehicle;

  return (
    <div className="min-h-dvh bg-ink px-6 py-10 text-cream">
      <div className="mx-auto max-w-lg">
        <Logo />
        <p className="mt-10 text-[11px] tracking-[0.4em] text-amber">SETUP {step + 1} / 3</p>
        {step === 0 && (
          <>
            <h1 className="mt-3 font-display text-4xl">The car.</h1>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <In label="Make" value={v?.make ?? ""} onChange={(x) => updateVehicle({ make: x })} />
              <In label="Model" value={v?.model ?? ""} onChange={(x) => updateVehicle({ model: x })} />
              <In label="Color" value={v?.color ?? ""} onChange={(x) => updateVehicle({ color: x })} />
              <In label="Year" value={v?.year ?? ""} onChange={(x) => updateVehicle({ year: x })} />
              <div className="col-span-2">
                <In label="Plate" value={v?.plate ?? ""} onChange={(x) => updateVehicle({ plate: x.toUpperCase() })} />
              </div>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <h1 className="mt-3 font-display text-4xl">The apps you drive.</h1>
            <div className="mt-6 grid grid-cols-2 gap-3">
              {PLATFORMS.map((p) => {
                const on = driver?.platforms.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      if (!driver) return;
                      const platforms = on ? driver.platforms.filter((x) => x !== p.id) : [...driver.platforms, p.id];
                      updateDriver({ platforms: platforms as Platform[] });
                    }}
                    className={`rounded-2xl border px-4 py-4 text-left ${on ? "border-amber bg-amber/10" : "border-line bg-panel"}`}
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-mist">{p.blurb}</div>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h1 className="mt-3 font-display text-4xl">Pair the rear glass.</h1>
            <p className="mt-3 text-mist">Scan the QR from the Glass tab or open the display-only link from the driver app. The code is passed automatically. While the driver switch is ON, the display keeps itself awake and fullscreen. Switch OFF to make it idle.</p>
            <div className="mt-8 rounded-3xl border border-amber/30 bg-panel py-10 text-center">
              <p className="text-[11px] tracking-[0.4em] text-mist">PAIR CODE</p>
              <p className="mt-3 font-cond text-6xl tracking-[0.28em] text-amber">{driver?.pairCode}</p>
            </div>
          </>
        )}
        <div className="mt-10 flex gap-3">
          {step > 0 && (
            <button onClick={() => setStep((s) => s - 1)} className="rounded-2xl border border-line px-5 py-3">
              Back
            </button>
          )}
          <button
            onClick={() => (step < 2 ? setStep((s) => s + 1) : go("/app"))}
            className="flex-1 rounded-2xl bg-amber py-3 font-semibold text-ink"
          >
            {step < 2 ? "Continue" : "Open console"}
          </button>
        </div>
      </div>
    </div>
  );
}

function In({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] tracking-[0.2em] text-mist">{label.toUpperCase()}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-xl border border-line bg-panel px-3 py-2.5 outline-none focus:border-amber" />
    </label>
  );
}
