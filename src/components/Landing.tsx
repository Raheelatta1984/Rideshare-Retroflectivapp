import { ArrowRight, BatteryCharging, EyeOff, Smartphone, Tablet, TimerReset, Zap } from "lucide-react";
import { Logo } from "./Logo";
import { PLATFORMS } from "../lib/platforms";

const HERO = "https://images.pexels.com/photos/19057545/pexels-photo-19057545.jpeg?auto=compress&cs=tinysrgb&w=1800";
const STREET = "https://images.pexels.com/photos/14116146/pexels-photo-14116146.jpeg?auto=compress&cs=tinysrgb&w=1400";
const DRIVER = "https://images.pexels.com/photos/8387441/pexels-photo-8387441.jpeg?auto=compress&cs=tinysrgb&w=1400";
const PICKUP = "https://images.pexels.com/photos/5357600/pexels-photo-5357600.jpeg?auto=compress&cs=tinysrgb&w=1400";
const CAR = "https://images.pexels.com/photos/15264156/pexels-photo-15264156.jpeg?auto=compress&cs=tinysrgb&w=1400";
const CLOSE = "/images/display-close.jpg";

export function Landing({ go }: { go: (path: string) => void }) {
  return (
    <div className="min-h-dvh bg-ink text-cream">
      <nav className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-white/5 bg-ink/70 px-5 py-3 backdrop-blur-md md:px-10">
        <Logo />
        <div className="hidden items-center gap-8 text-sm text-mist md:flex">
          <button onClick={() => go("/review")} className="hover:text-cream">Review</button>
          <a href="#how" className="hover:text-cream">How it works</a>
          <a href="#bridge" className="hover:text-cream">Uber + DiDi</a>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => go("/login")} className="hidden rounded-full px-4 py-2 text-sm text-mist hover:text-cream sm:inline">
            Driver login
          </button>
          <button onClick={() => go("/lab")} className="rounded-full bg-amber px-4 py-2 text-sm font-semibold text-ink">
            Test the lab
          </button>
        </div>
      </nav>

      <header className="relative isolate min-h-dvh overflow-hidden">
        <img src={HERO} alt="" className="absolute inset-0 h-full w-full object-cover opacity-50" />
        <div className="absolute inset-0 bg-gradient-to-b from-ink via-ink/55 to-ink" />
        <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col justify-end px-6 pb-20 pt-32 md:px-10">
          <p className="text-[11px] tracking-[0.48em] text-amber">FOR THE REAR GLASS · EVERY PLATFORM</p>
          <h1 className="mt-4 max-w-4xl font-display text-5xl leading-[0.92] md:text-8xl">
            One switch.
            <span className="block text-amber">The whole glass.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-cream/75">
            A tablet on the inside of the rear window. Flip the phone switch ON and it lights up with your rideshare apps — Uber, DiDi, Lyft. Flip OFF and it drops to idle black and frees the device.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <button onClick={() => go("/lab")} className="inline-flex items-center gap-2 rounded-full bg-cream px-6 py-3 font-semibold text-ink">
              Review the pair lab <ArrowRight className="h-4 w-4" />
            </button>
            <button onClick={() => go("/demo")} className="inline-flex items-center gap-2 rounded-full border border-white/15 px-6 py-3">
              Live preview
            </button>
            <button onClick={() => go("/display")} className="inline-flex items-center gap-2 rounded-full border border-white/15 px-6 py-3">
              <Tablet className="h-4 w-4 text-amber" /> Arm a tablet
            </button>
          </div>
          <div className="mt-12 grid grid-cols-3 gap-6 border-t border-white/10 pt-6 text-sm md:max-w-xl">
            <Stat k="Flip ON" v="Wake the glass" />
            <Stat k="Flip OFF" v="Idle + save power" />
            <Stat k="8 apps" v="Pick for the glass" />
          </div>
        </div>
      </header>

      <section className="border-y border-amber/20 bg-amber text-ink">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm md:px-10">
          <p className="font-medium">Review this build first — no GitHub, no Neon, no signup required.</p>
          <p className="text-xs tracking-wide">
            Demo booth <span className="font-semibold">driver@retroflex.app</span> · password <span className="font-semibold">demo1234</span> · pair <span className="font-semibold">7K2M9Q</span>
          </p>
        </div>
      </section>

      <section className="border-y border-white/5 bg-ink-2 py-6">
        <div className="marquee-track flex w-max gap-16 px-8 text-[11px] tracking-[0.35em] text-mist">
          {[...PLATFORMS, ...PLATFORMS].map((p, i) => (
            <span key={i} className="flex items-center gap-3">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.accent }} />
              {p.name.toUpperCase()}
            </span>
          ))}
        </div>
      </section>

      <section id="how" className="mx-auto max-w-6xl px-6 py-24 md:px-10">
        <p className="text-[11px] tracking-[0.4em] text-amber">THE LOOP</p>
        <h2 className="mt-3 max-w-3xl font-display text-4xl md:text-6xl">Mount. Pair. Switch. Done.</h2>
        <div className="mt-14 grid gap-6 md:grid-cols-4">
          {[
            { n: "01", t: "Mount + pair", d: "Landscape tablet on the inside of the rear glass, facing the street. Pair it to the phone with the code.", i: BatteryCharging },
            { n: "02", t: "Pair the phone", d: "Driver console talks to the tablet over a six-character code. Different devices, one car.", i: Smartphone },
            { n: "03", t: "Flip the switch", d: "Tap ON and the glass lights up with your rideshare apps. Tap OFF and it sleeps.", i: Zap },
            { n: "04", t: "Pick the app", d: "Uber, DiDi, Lyft — choose on the phone which rideshare the glass is showing.", i: TimerReset },
          ].map((s) => (
            <article key={s.n} className="rounded-3xl border border-line bg-panel p-6">
              <s.i className="h-5 w-5 text-amber" />
              <p className="mt-8 text-[11px] tracking-[0.3em] text-mist">{s.n}</p>
              <h3 className="mt-2 font-display text-2xl">{s.t}</h3>
              <p className="mt-3 text-sm leading-relaxed text-mist">{s.d}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="display" className="bg-ink-2 py-24">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 md:grid-cols-2 md:px-10">
          <div className="tablet-frame overflow-hidden bg-black">
            <img src={CLOSE} alt="Rideshare apps on the rear window" className="aspect-[16/10] w-full object-cover" />
          </div>
          <div>
            <p className="text-[11px] tracking-[0.4em] text-amber">DESIGNED TO READ THROUGH TINT</p>
            <h2 className="mt-3 font-display text-4xl md:text-5xl">Your apps, on the glass. Nothing else.</h2>
            <p className="mt-5 text-mist">
              When the phone says ON, the tablet shows the rideshare apps you picked. OLED black when it is OFF. Amber mode is the retroreflective cousin — the reason the product is named Retroflex. Theme, brightness and which apps appear are all set from the phone.
            </p>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                "Idle black when OFF — frees the tablet's resources",
                "Wake the second the phone switch flips ON",
                "Show only the apps you enable (Uber, DiDi, Lyft…)",
                "Rotates 180° if the mount is inverted",
              ].map((x) => (
                <li key={x} className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-6 py-24 md:grid-cols-3 md:px-10">
        <Figure src={DRIVER} cap="Driver console on the phone you already hold." />
        <Figure src={PICKUP} cap="A big ON/OFF switch controls the whole glass." />
        <Figure src={CAR} cap="Hardware is any cheap Android tablet on a suction mount." />
      </section>

      <section id="bridge" className="border-y border-white/5 bg-panel py-24">
        <div className="mx-auto max-w-6xl px-6 md:px-10">
          <div className="grid items-end gap-10 md:grid-cols-2">
            <div>
              <p className="text-[11px] tracking-[0.4em] text-amber">THE BRIDGE</p>
              <h2 className="mt-3 font-display text-4xl md:text-5xl">Talks to Uber, DiDi and the rest — without living inside them.</h2>
            </div>
            <p className="text-mist">
              Official rideshare APIs are closed. Retroflex sits beside those apps. You choose which apps the rear glass shows and flip it all on from one switch on your phone. No driver accounts needed on the tablet.
            </p>
          </div>
          <div className="mt-12 grid gap-4 md:grid-cols-4">
            {PLATFORMS.map((p) => (
              <div key={p.id} className="rounded-2xl border border-line bg-ink p-5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl font-cond text-sm" style={{ background: p.color, color: p.text }}>
                  {p.short.slice(0, 2)}
                </div>
                <p className="mt-4 font-medium">{p.name}</p>
                <p className="text-xs text-mist">{p.blurb}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative isolate overflow-hidden py-28">
        <img src={STREET} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />
        <div className="absolute inset-0 bg-gradient-to-r from-ink via-ink/80 to-ink/40" />
        <div className="relative mx-auto max-w-6xl px-6 md:px-10">
          <EyeOff className="h-6 w-6 text-amber" />
          <h2 className="mt-6 max-w-3xl font-display text-4xl md:text-6xl">OFF means the glass is a black rectangle.</h2>
          <p className="mt-5 max-w-lg text-cream/70">
            No looping ads. No clock. Flip the switch OFF and the tablet stops using its resources — until you tap it back ON and the apps light up.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <button onClick={() => go("/lab")} className="rounded-full bg-amber px-6 py-3 font-semibold text-ink">
              Test phone + tablet
            </button>
            <button onClick={() => go("/review")} className="rounded-full border border-white/20 px-6 py-3">
              Review checklist
            </button>
          </div>
        </div>
      </section>

      <section className="border-t border-white/5 bg-ink-2 py-20">
        <div className="mx-auto max-w-6xl px-6 md:px-10">
          <p className="text-[11px] tracking-[0.4em] text-amber">AFTER YOU REVIEW</p>
          <h2 className="mt-3 max-w-3xl font-display text-4xl md:text-5xl">Park it in a GitHub repo. Open Codespaces. No database.</h2>
          <p className="mt-4 max-w-2xl text-mist">
            Target repo is ready: github.com/Raheelatta1984/Rideshare-Retroflectivapp. Push this folder, then open Codespaces. Vite starts on port 5173. GitHub Pages publishes a public share link.
          </p>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              { n: "01", t: "Push from Termux", d: "Copy this folder to Downloads. In Termux: bash termux-push.sh — sign in with a browser code." },
              { n: "02", t: "Open Codespaces", d: "Code → Codespaces on Rideshare-Retroflectivapp. Vite boots on 5173." },
              { n: "03", t: "Share the demo", d: "Forward 5173 as public, or turn on Pages. Lab lives at #/lab." },
            ].map((s) => (
              <div key={s.n} className="rounded-2xl border border-line bg-panel p-5">
                <p className="text-[11px] tracking-[0.3em] text-mist">{s.n}</p>
                <p className="mt-2 font-display text-2xl">{s.t}</p>
                <p className="mt-2 text-sm text-mist">{s.d}</p>
              </div>
            ))}
          </div>
          <a
            href="https://github.com/Raheelatta1984/Rideshare-Retroflectivapp"
            className="mt-8 inline-flex rounded-full bg-cream px-5 py-2.5 text-sm font-semibold text-ink"
          >
            Open the GitHub repo
          </a>
        </div>
      </section>

      <footer className="border-t border-white/5 px-6 py-10 text-xs text-mist md:px-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <Logo />
          <p>© {new Date().getFullYear()} Retroflex · Rear Beacon OS · Built for the curb.</p>
        </div>
      </footer>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="font-cond text-xl tracking-wide text-cream">{v}</div>
      <div className="mt-1 text-[11px] text-mist">{k}</div>
    </div>
  );
}

function Figure({ src, cap }: { src: string; cap: string }) {
  return (
    <figure className="overflow-hidden rounded-3xl border border-line">
      <img src={src} alt="" className="aspect-[4/3] w-full object-cover" />
      <figcaption className="bg-panel px-5 py-4 text-sm text-mist">{cap}</figcaption>
    </figure>
  );
}
