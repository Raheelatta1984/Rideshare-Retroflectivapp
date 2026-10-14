import { useState, type ReactNode } from "react";
import { StoreProvider, useStore } from "./store";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { normalizeDeviceProfile } from "./lib/devices";
import { normalizePairCode } from "./lib/id";
import { useHash, useNow } from "./hooks";
import { db } from "./lib/storage";
import { parseTerminalRequest, terminalConsentKey, type TerminalRequest } from "./lib/terminals";
import { TerminalSetup } from "./components/TerminalSetup";
import type { TerminalBinding } from "./types";
import { Landing } from "./components/Landing";
import { Auth } from "./components/Auth";
import { ForgotPassword, ResetPassword, VerifyResetCode } from "./components/PasswordReset";
import { Onboarding } from "./components/Onboarding";
import { DriverConsole } from "./components/DriverConsole";
import { DemoStudio } from "./components/DemoStudio";
import { DisplayPairGate, DisplayScreen } from "./components/DisplayScreen";
import { ReviewLab } from "./components/ReviewLab";
import { ReviewGuide } from "./components/ReviewGuide";
import { DownloadZip } from "./components/DownloadZip";
import { canDownloadSource } from "./lib/access";

export default function App() {
  return (
    <ErrorBoundary>
      <StoreProvider>
      <Router />
      </StoreProvider>
    </ErrorBoundary>
  );
}

function Router() {
  const [path, go] = useHash();
  const route = path.split("?")[0];
  const routeQuery = new URLSearchParams(path.split("?")[1] ?? "");
  // Query pairing survives QR scanners that strip hash fragments.
  const pageQuery = new URLSearchParams(window.location.search);
  const tabletCode = pageQuery.get("display");
  const tabletMode = pageQuery.get("mode") === "tablet";
  const tabletPosition = pageQuery.get("position") === "front" ? "front" : "rear";
  const resetMode = pageQuery.get("mode") === "reset";
  const resetToken = pageQuery.get("token");

  if (resetMode) {
    return <ResetPassword token={resetToken ?? ""} go={go} />;
  }

  // Scanned terminal QR (?mode=terminal, or #/terminal). Checked before every
  // website route on purpose: a terminal shows sign-up/login, then the glass.
  // Nothing else from the site is reachable from here.
  const terminalRequest = parseTerminalRequest(window.location.search, path);
  if (terminalRequest.active) {
    return <TerminalFlow request={terminalRequest} go={go} />;
  }

  if (tabletCode && tabletMode) {
    return <TabletAccess code={tabletCode.replace(/[^A-Za-z0-9]/g, "")} position={tabletPosition} go={go} />;
  }

  if (tabletCode) {
    return (
      <div className="h-dvh w-full bg-black">
        <TabletAccess code={tabletCode.replace(/[^A-Za-z0-9]/g, "")} position={tabletPosition} go={go} />
      </div>
    );
  }

  if (route === "/" || route === "") return <Landing go={go} />;
  if (route === "/login") return <Auth mode="login" go={go} />;
  if (route === "/forgot-password") return <ForgotPassword go={go} />;
  if (route === "/verify-reset") return <VerifyResetCode email={routeQuery.get("email") ?? ""} go={go} />;
  if (route === "/reset-password") return <ResetPassword token={routeQuery.get("token") ?? ""} go={go} />;
  if (route === "/signup") return <Auth mode="signup" go={go} />;
  if (route === "/demo") return <DemoStudio go={go} />;
  if (route === "/lab") return <ReviewLab go={go} />;
  if (route === "/review") return <ReviewGuide go={go} />;
  if (route === "/source-vault") return <SourceGate go={go}><DownloadZip go={go} /></SourceGate>;
  if (route === "/onboarding") {
    return (
      <Gate go={go}>
        <Onboarding go={go} />
      </Gate>
    );
  }
  if (route.startsWith("/app")) {
    return (
      <Gate go={go}>
        <DriverConsole go={go} />
      </Gate>
    );
  }
  if (route === "/display") {
    return <DisplayPairGate onPaired={(code) => go(`/display/${code}`)} onBack={() => go("/")} />;
  }
  if (route.startsWith("/display/")) {
    const code = route.replace("/display/", "").replace(/[^A-Za-z0-9]/g, "");
    return (
      <div className="h-dvh w-full bg-black">
        <TabletAccess code={code} position={routeQuery.get("position") === "front" ? "front" : "rear"} go={go} />
      </div>
    );
  }
  return <Landing go={go} />;
}

function SourceGate({ children, go }: { children: ReactNode; go: (p: string) => void }) {
  const { ready, driver } = useStore();
  if (!ready) return <div className="grid min-h-dvh place-items-center bg-ink text-[11px] tracking-[0.4em] text-mist">CHECKING ACCESS</div>;
  if (!driver) {
    return <div className="grid min-h-dvh place-items-center bg-ink px-6 text-center text-mist"><button onClick={() => go("/login")} className="rounded-full bg-amber px-5 py-2 font-semibold text-ink">Driver login</button></div>;
  }
  if (!canDownloadSource(driver.email)) {
    return <div className="grid min-h-dvh place-items-center bg-ink px-6 text-center text-mist">Source Vault is available only to the owner and approved demo admin accounts.</div>;
  }
  return <>{children}</>;
}

/**
 * The scanned-terminal flow.
 *
 * Assigned already → the glass. Not assigned → sign-up / pair-code login, then
 * one Assign step. There is deliberately no route out to the rest of the site.
 */
function TerminalFlow({ request, go }: { request: TerminalRequest; go: (p: string) => void }) {
  const { ready, terminalBinding } = useStore();
  const [assigned, setAssigned] = useState<TerminalBinding | null>(null);
  const binding = assigned ?? terminalBinding;

  if (!ready) {
    return <div className="grid min-h-dvh place-items-center bg-ink text-[11px] tracking-[0.4em] text-mist">CHECKING TERMINAL</div>;
  }

  const authorized = !!binding && localStorage.getItem(terminalConsentKey(binding.position, binding.pairCode)) === "yes";
  if (binding && authorized) {
    return (
      <div className="h-dvh w-full bg-black">
        <TabletAccess code={binding.pairCode} position={binding.position} go={go} />
      </div>
    );
  }

  return (
    <TerminalSetup
      code={request.code ?? binding?.pairCode ?? null}
      position={binding?.position ?? request.position}
      onAssigned={setAssigned}
    />
  );
}

function TabletAccess({ code, position, go }: { code: string; position: "rear" | "front"; go: (p: string) => void }) {
  const key = terminalConsentKey(position, code);
  const [authorized, setAuthorized] = useState(() => localStorage.getItem(key) === "yes");
  const [showLog, setShowLog] = useState(false);

  if (authorized) {
    return (
      <div className="h-dvh w-full bg-black">
        {showLog ? <TabletLogScreen code={code} position={position} onBack={() => setShowLog(false)} /> : <PairedDisplay code={code} position={position} go={go} onExit={() => setShowLog(true)} />}
      </div>
    );
  }

  return <TabletConnectGate code={code} position={position} onConnect={() => {
    localStorage.setItem(key, "yes");
    setAuthorized(true);
  }} />;
}

function TabletLogScreen({ code, position, onBack }: { code: string; position: "rear" | "front"; onBack: () => void }) {
  const now = useNow(1000);
  const deviceId = localStorage.getItem("rf:tablet-device-id") ?? "unassigned";
  const logs = db.listTabletActivity(code, deviceId);
  return (
    <div className="min-h-dvh overflow-y-auto bg-ink px-5 py-7 text-cream">
      <button onClick={onBack} className="rounded-full border border-line px-4 py-2 text-sm text-mist">Back to display</button>
      <p className="mt-8 text-[11px] tracking-[0.4em] text-amber">{position.toUpperCase()} TABLET LOG</p>
      <h1 className="mt-2 font-display text-3xl">Local device activity</h1>
      <p className="mt-2 text-xs text-mist">Pair {code} · Device {deviceId.slice(-6)} · refresh {new Date(now).toLocaleTimeString()}</p>
      <div className="mt-6 space-y-2">
        {logs.length === 0 && <p className="text-sm text-mist">No local display events yet.</p>}
        {logs.map((log) => (
          <details key={log.id} className="rounded-2xl border border-line bg-panel px-4 py-3">
            <summary className="cursor-pointer list-none"><p className="text-sm text-cream">{log.action}</p><p className="mt-1 text-[10px] text-mist">{new Date(log.at).toLocaleString()}</p></summary>
            {log.details && <div className="mt-3 border-t border-line pt-3 text-xs text-mist">{Object.entries(log.details).map(([key, value]) => <p key={key} className="mt-1">{key}: {String(value)}</p>)}</div>}
          </details>
        ))}
      </div>
    </div>
  );
}

function TabletConnectGate({ code, position, onConnect }: { code: string; position: "rear" | "front"; onConnect: () => void }) {
  const connect = () => {
    const element = document.documentElement;
    if (element.requestFullscreen) void element.requestFullscreen().catch(() => undefined);
    onConnect();
  };
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink px-6 text-center text-cream">
      <div className="max-w-sm">
        <p className="text-[11px] tracking-[0.45em] text-amber">RETROFLEX {position.toUpperCase()} TABLET</p>
        <h1 className="mt-4 font-display text-4xl">Connect {position} display</h1>
        <p className="mt-4 text-sm leading-relaxed text-mist">Pair code <span className="font-cond text-xl tracking-[0.18em] text-cream">{code}</span>. The paired driver may control only this Retroflex screen: logo, brightness and display schedule. It cannot access other apps, files, camera, contacts or device settings.</p>
        <button onClick={connect} className="mt-8 w-full rounded-2xl bg-amber py-4 font-semibold text-ink">I authorize display control</button>
        <p className="mt-4 text-xs text-mist">This device stores its pairing permission locally. Revoke it by clearing site data in the browser.</p>
      </div>
    </div>
  );
}

function Gate({ children, go }: { children: ReactNode; go: (p: string) => void }) {
  const { ready, driver } = useStore();
  if (!ready) {
    return (
      <div className="grid min-h-dvh place-items-center bg-ink text-mist">
        <p className="text-[11px] tracking-[0.4em]">ARMING BOOTH</p>
      </div>
    );
  }
  if (!driver) {
    return (
      <div className="grid min-h-dvh place-items-center bg-ink text-cream">
        <div className="text-center">
          <p className="text-mist">The booth is locked.</p>
          <button onClick={() => go("/login")} className="mt-4 rounded-full bg-amber px-5 py-2 font-semibold text-ink">
            Driver login
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

function PairedDisplay({ code, position = "rear", go, onExit }: { code: string; position?: "rear" | "front"; go: (p: string) => void; onExit?: () => void }) {
  const { driver, powered, activeRide, settings, terminalBinding, terminalBooth } = useStore();
  const wanted = normalizePairCode(code);
  const sameBooth = !!driver && normalizePairCode(position === "front" ? driver.frontPairCode : driver.pairCode) === wanted;
  const directProfile = sameBooth
    ? settings.deviceProfiles?.map(normalizeDeviceProfile).find((profile) => profile.position === position && profile.pairCode === code && !profile.deviceId)
    : undefined;
  const positionMaster = position === "front" ? (settings.frontMasterOn ?? true) : (settings.rearMasterOn ?? true);

  // A terminal assigned through the QR flow has no console session — that is the
  // point, the console stays locked on the glass. When its booth is known (local
  // record or shared backend) the display still follows the owner's settings.
  const boundBooth =
    !sameBooth && terminalBinding && terminalBooth
      && terminalBinding.position === position
      && normalizePairCode(terminalBinding.pairCode) === wanted
      && terminalBinding.accountId === terminalBooth.account.id
      ? terminalBooth
      : null;
  const boothMaster = boundBooth ? (boundBooth.settings.masterOn ?? false) && positionMaster : false;

  return (
    <DisplayScreen
      pairCode={code}
      ride={sameBooth ? activeRide : undefined}
      position={position}
      settings={sameBooth ? { ...settings, masterOn: powered && positionMaster, apps: directProfile?.apps ?? driver?.platforms } : undefined}
      powered={sameBooth ? powered && positionMaster && (directProfile?.powered ?? true) : undefined}
      // A bound terminal follows its booth until the driver phone speaks, then
      // the phone wins — management stays on the mobile, as designed.
      bootstrapSettings={!sameBooth && boundBooth ? { ...boundBooth.settings, masterOn: boothMaster } : undefined}
      onExit={onExit ?? (() => go("/"))}
    />
  );
}
