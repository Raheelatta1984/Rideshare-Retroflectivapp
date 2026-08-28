import { ArrowLeft, FolderGit2, MonitorPlay, Smartphone, Tablet } from "lucide-react";
import { Logo } from "./Logo";

export function ReviewGuide({ go }: { go: (p: string) => void }) {
  return (
    <div className="min-h-dvh bg-ink px-5 py-8 text-cream">
      <div className="mx-auto max-w-3xl">
        <button onClick={() => go("/")} className="inline-flex items-center gap-2 text-sm text-mist hover:text-cream">
          <ArrowLeft className="h-4 w-4" /> Home
        </button>
        <div className="mt-8">
          <Logo />
        </div>
        <p className="mt-10 text-[11px] tracking-[0.4em] text-amber">HOW TO REVIEW THIS BUILD</p>
        <h1 className="mt-3 font-display text-4xl md:text-6xl">Click through the car, then park it on GitHub.</h1>
        <p className="mt-4 max-w-xl text-mist">
          Nothing here needs a backend. One big ON/OFF switch controls the rear glass and your rideshare apps. Turn it on and the tablet lights up with Uber, DiDi, Lyft. Turn it off and it drops to idle black. No customer names.
        </p>

        <ol className="mt-10 space-y-4">
          <Item n="01" icon={MonitorPlay} title="Open the pair lab" body="Phone and rear tablet on one screen. Flip the ON/OFF switch and the glass follows instantly." action="Open lab" onClick={() => go("/lab")} />
          <Item n="02" icon={Smartphone} title="Sign into the driver booth" body="Use an authorized driver, supervisor or administrator account to control the rear glass, device profiles and operational settings." action="Driver login" onClick={() => go("/login")} />
          <Item n="03" icon={Tablet} title="Arm a second window as the tablet" body="Open #/display and type 7K2M9Q, or jump straight to the paired display. Keep that window landscape." action="Arm display" onClick={() => go("/display/7K2M9Q")} />
          <Item n="04" icon={FolderGit2} title="Private source handling" body="Public users cannot download project source from this app. Keep repository access and source exports in a private GitHub or Codespaces workspace owned by the technical account." />
        </ol>

        <div className="mt-10 rounded-3xl border border-amber/30 bg-panel p-6">
          <p className="text-[11px] tracking-[0.3em] text-amber">PRIVATE BOOTH ACCESS</p>
          <p className="mt-2 text-mist">Account credentials, technical guidance and source controls are shown only inside the authorized Booth.</p>
        </div>
      </div>
    </div>
  );
}

function Item({
  n,
  icon: Icon,
  title,
  body,
  action,
  onClick,
}: {
  n: string;
  icon: typeof FolderGit2;
  title: string;
  body: string;
  action?: string;
  onClick?: () => void;
}) {
  return (
    <li className="rounded-3xl border border-line bg-panel p-5">
      <div className="flex items-start gap-4">
        <Icon className="mt-1 h-5 w-5 text-amber" />
        <div>
          <p className="text-[11px] tracking-[0.3em] text-mist">{n}</p>
          <h2 className="mt-1 font-display text-2xl">{title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-mist">{body}</p>
          {action && onClick && (
            <button onClick={onClick} className="mt-4 rounded-full bg-cream px-4 py-2 text-sm font-semibold text-ink">
              {action}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
