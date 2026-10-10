import { useEffect, useRef, useState } from "react";
import { ChevronMark } from "./Logo";
import { useStore } from "../store";
import { formatPair } from "../lib/id";
import type { PairCodeResolution } from "../lib/backend/types";
import type { TerminalAccount, TerminalBinding, TerminalOrigin, TerminalPosition } from "../types";
import {
  defaultTerminalLabel,
  deviceHint,
  sanitizePairInput,
  validateTerminalSignUp,
} from "../lib/terminals";

/**
 * Terminal sign-up shell.
 *
 * This is the whole experience on a scanned terminal: pair-code login (or
 * sign-up), one Assign step, then the glass. It deliberately renders none of the
 * website — no landing, no nav, no lab/demo/review links — because a tablet
 * glued to a rear window is not a browsing device. Everything after assignment
 * is driven from the driver's phone.
 */

type Step = "gate" | "code" | "signup" | "email" | "assign";

interface Props {
  /** Pair code carried by the QR, when the driver's coded QR was scanned. */
  code: string | null;
  position: TerminalPosition;
  onAssigned: (binding: TerminalBinding) => void;
}

export function TerminalSetup({ code, position, onAssigned }: Props) {
  const { resolveTerminalCode, signUpTerminal, signInTerminal, assignTerminal } = useStore();

  // A coded QR skips the gate: the code is already known, so the only thing left
  // to do is say which glass it is and what to call it.
  const [step, setStep] = useState<Step>(code ? "assign" : "gate");
  const [pairCodeValue, setPairCodeValue] = useState(code ?? "");
  const [resolution, setResolution] = useState<PairCodeResolution | null>(null);
  const [account, setAccount] = useState<TerminalAccount | null>(null);
  const [origin, setOrigin] = useState<TerminalOrigin>(code ? "url" : "pair-code");
  const [chosenPosition, setChosenPosition] = useState<TerminalPosition>(position);
  const [deviceName, setDeviceName] = useState(() => defaultTerminalLabel(position, deviceHint()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSubmitted = useRef(false);

  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "", city: "" });

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const failure = await work();
      if (failure) setError(failure);
      return !failure;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const enterAssign = (nextCode: string, nextResolution: PairCodeResolution | null, nextOrigin: TerminalOrigin) => {
    setPairCodeValue(nextCode);
    setResolution(nextResolution);
    setOrigin(nextOrigin);
    setChosenPosition(nextResolution?.position ?? position);
    setDeviceName(defaultTerminalLabel(nextResolution?.position ?? position, deviceHint()));
    setStep("assign");
  };

  const submitCode = async (raw: string) => {
    const value = sanitizePairInput(raw);
    if (value.length !== 6) {
      setError("A pair code is six characters.");
      return;
    }
    const ok = await run(async () => {
      const result = await resolveTerminalCode(value);
      if (result.error) return result.error;
      setAccount(result.account);
      enterAssign(result.code, result, "pair-code");
      return null;
    });
    if (!ok) setStep("code");
  };

  const submitSignUp = async (event: React.FormEvent) => {
    event.preventDefault();
    const { error: validationError, value } = validateTerminalSignUp(form);
    if (validationError) {
      setError(validationError);
      return;
    }
    await run(async () => {
      const result = await signUpTerminal(value);
      if (result.error || !result.account) return result.error ?? "Sign-up failed.";
      setAccount(result.account);
      enterAssign(result.account.pairCode, {
        code: result.account.pairCode,
        position: chosenPosition,
        account: result.account,
        verified: true,
        error: null,
      }, "signup");
      return null;
    });
  };

  const submitEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(async () => {
      const result = await signInTerminal({ email: form.email, password: form.password });
      if (result.error || !result.account) return result.error ?? "Login failed.";
      setAccount(result.account);
      const codeForPosition = chosenPosition === "front"
        ? result.account.frontPairCode ?? result.account.pairCode
        : result.account.pairCode;
      enterAssign(codeForPosition, {
        code: codeForPosition,
        position: chosenPosition,
        account: result.account,
        verified: true,
        error: null,
      }, "email");
      return null;
    });
  };

  const submitAssign = async (event: React.FormEvent) => {
    event.preventDefault();
    // Fullscreen needs a user gesture; this button is the last one they press
    // before the tablet becomes a display.
    const element = document.documentElement;
    if (element.requestFullscreen) void element.requestFullscreen().catch(() => undefined);

    const label = deviceName.trim() || defaultTerminalLabel(chosenPosition, deviceHint());
    await run(async () => {
      const result = await assignTerminal({
        pairCode: pairCodeValue,
        position: chosenPosition,
        deviceName: label,
        origin,
        account,
      });
      if (result.error || !result.binding) return result.error ?? "Could not assign this terminal.";
      onAssigned(result.binding);
      return null;
    });
  };

  // Scan-and-go: a full six-character code submits itself.
  useEffect(() => {
    if (step !== "code" || busy || autoSubmitted.current) return;
    if (pairCodeValue.length === 6) {
      autoSubmitted.current = true;
      void submitCode(pairCodeValue);
    }
  }, [step, busy, pairCodeValue]);

  useEffect(() => {
    if (step !== "code") autoSubmitted.current = false;
  }, [step]);

  return (
    <div className="min-h-dvh bg-ink text-cream">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 py-10">
        <header className="flex items-center gap-3">
          <ChevronMark className="h-9 w-9 text-amber" />
          <div className="leading-none">
            <p className="font-display text-[15px] tracking-[0.14em]">RETROFLEX</p>
            <p className="mt-1 text-[9px] tracking-[0.28em] text-amber/80">TERMINAL SETUP</p>
          </div>
        </header>

        <main className="flex flex-1 flex-col justify-center py-10">
          {step === "gate" && (
            <Gate
              onCode={() => {
                setError(null);
                setStep("code");
              }}
              onSignUp={() => {
                setError(null);
                setStep("signup");
              }}
              onEmail={() => {
                setError(null);
                setStep("email");
              }}
            />
          )}

          {step === "code" && (
            <CodeStep
              value={pairCodeValue}
              busy={busy}
              error={error}
              onChange={(next) => {
                setPairCodeValue(sanitizePairInput(next));
                setError(null);
              }}
              onSubmit={() => void submitCode(pairCodeValue)}
              onBack={() => setStep("gate")}
            />
          )}

          {step === "signup" && (
            <FormStep
              title="Create the account."
              caption="One account for the driver and every terminal. Takes a minute."
              busy={busy}
              error={error}
              submitLabel="Create account"
              onSubmit={submitSignUp}
              onBack={() => setStep("gate")}
            >
              <Field label="Full name" value={form.name} onChange={(name) => setForm((f) => ({ ...f, name }))} autoComplete="name" />
              <Field label="Email" type="email" value={form.email} onChange={(email) => setForm((f) => ({ ...f, email }))} autoComplete="email" />
              <Field label="Password" type="password" value={form.password} onChange={(password) => setForm((f) => ({ ...f, password }))} autoComplete="new-password" hint="At least 8 characters" />
              <Field label="Phone" type="tel" value={form.phone} onChange={(phone) => setForm((f) => ({ ...f, phone }))} autoComplete="tel" optional />
              <Field label="City" value={form.city} onChange={(city) => setForm((f) => ({ ...f, city }))} autoComplete="address-level2" optional />
            </FormStep>
          )}

          {step === "email" && (
            <FormStep
              title="Back in the booth."
              caption="Log in, then pick which glass this terminal is."
              busy={busy}
              error={error}
              submitLabel="Log in"
              onSubmit={submitEmail}
              onBack={() => setStep("gate")}
            >
              <Field label="Email" type="email" value={form.email} onChange={(email) => setForm((f) => ({ ...f, email }))} autoComplete="email" />
              <Field label="Password" type="password" value={form.password} onChange={(password) => setForm((f) => ({ ...f, password }))} autoComplete="current-password" />
            </FormStep>
          )}

          {step === "assign" && (
            <AssignStep
              pairCode={pairCodeValue}
              resolution={resolution}
              account={account}
              position={chosenPosition}
              deviceName={deviceName}
              busy={busy}
              error={error}
              onPosition={(next) => {
                setChosenPosition(next);
                setDeviceName(defaultTerminalLabel(next, deviceHint()));
              }}
              onDeviceName={setDeviceName}
              onSubmit={submitAssign}
              onUseOtherCode={() => {
                setError(null);
                setStep("code");
              }}
              canChangeCode={origin !== "signup"}
            />
          )}
        </main>

        <footer className="text-[10px] leading-relaxed tracking-[0.14em] text-mist/70">
          AFTER ASSIGNING, THIS SCREEN BECOMES THE DISPLAY. BRIGHTNESS, APPS, POWER AND CAMPAIGNS ARE
          CONTROLLED FROM THE DRIVER PHONE.
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ screens */

function Gate({ onCode, onSignUp, onEmail }: { onCode: () => void; onSignUp: () => void; onEmail: () => void }) {
  return (
    <div>
      <h1 className="font-display text-4xl leading-[0.95]">
        Set up this
        <span className="block text-amber">terminal.</span>
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-mist">
        Enter the six-character pair code from your driver, or create an account and this terminal gets its own code.
      </p>
      <button onClick={onCode} className="mt-8 w-full rounded-2xl bg-amber py-4 font-semibold text-ink">
        I have a pair code
      </button>
      <button onClick={onSignUp} className="mt-3 w-full rounded-2xl border border-line bg-panel py-4 font-semibold text-cream">
        Create a terminal account
      </button>
      <button onClick={onEmail} className="mt-6 w-full text-xs text-mist underline underline-offset-4">
        Log in with email instead
      </button>
    </div>
  );
}

function CodeStep({
  value,
  busy,
  error,
  onChange,
  onSubmit,
  onBack,
}: {
  value: string;
  busy: boolean;
  error: string | null;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <BackLabel onClick={onBack} />
      <h1 className="mt-4 font-display text-4xl">Your pair code.</h1>
      <p className="mt-3 text-sm leading-relaxed text-mist">
        It is in the driver app under Glass, and on the QR sticker that came with the terminal.
      </p>
      <input
        value={formatPair(value)}
        onChange={(event) => onChange(event.target.value)}
        autoFocus
        required
        minLength={6}
        maxLength={7}
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        aria-label="Pair code"
        placeholder="7K2 M9Q"
        className="mt-8 w-full rounded-2xl border border-line bg-panel py-6 text-center font-cond text-5xl tracking-[0.22em] text-amber outline-none focus:border-amber"
      />
      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
      <button type="submit" disabled={busy || value.length !== 6} className="mt-6 w-full rounded-2xl bg-amber py-4 font-semibold text-ink disabled:opacity-40">
        {busy ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}

function FormStep({
  title,
  caption,
  busy,
  error,
  submitLabel,
  onSubmit,
  onBack,
  children,
}: {
  title: string;
  caption: string;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (event: React.FormEvent) => void;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <BackLabel onClick={onBack} />
      <h1 className="mt-4 font-display text-4xl">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-mist">{caption}</p>
      <div className="mt-6 space-y-4">{children}</div>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <button type="submit" disabled={busy} className="w-full rounded-2xl bg-amber py-4 font-semibold text-ink disabled:opacity-40">
        {busy ? "Working…" : submitLabel}
      </button>
    </form>
  );
}

function AssignStep({
  pairCode,
  resolution,
  account,
  position,
  deviceName,
  busy,
  error,
  onPosition,
  onDeviceName,
  onSubmit,
  onUseOtherCode,
  canChangeCode,
}: {
  pairCode: string;
  resolution: PairCodeResolution | null;
  account: TerminalAccount | null;
  position: TerminalPosition;
  deviceName: string;
  busy: boolean;
  error: string | null;
  onPosition: (next: TerminalPosition) => void;
  onDeviceName: (next: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onUseOtherCode: () => void;
  canChangeCode: boolean;
}) {
  const ownerName = resolution?.account?.name ?? account?.name ?? null;
  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <p className="text-[11px] tracking-[0.4em] text-amber">LAST STEP</p>
      <h1 className="font-display text-4xl leading-[0.95]">Assign this terminal.</h1>

      <div className="rounded-3xl border border-amber/30 bg-panel py-7 text-center">
        <p className="text-[10px] tracking-[0.34em] text-mist">PAIR CODE</p>
        <p className="mt-3 font-cond text-5xl tracking-[0.24em] text-amber">{formatPair(pairCode)}</p>
        <p className="mt-3 text-xs text-mist">
          {resolution?.verified
            ? ownerName
              ? `Confirmed · booth of ${ownerName}`
              : "Confirmed"
            : "Not confirmed on this device — see the note below"}
        </p>
        {canChangeCode && (
          <button type="button" onClick={onUseOtherCode} className="mt-3 text-xs text-cream underline underline-offset-4">
            Use a different code
          </button>
        )}
      </div>

      <div>
        <p className="mb-2 text-[11px] tracking-[0.22em] text-mist">WHICH GLASS</p>
        <div className="grid grid-cols-2 gap-3">
          <PositionButton label="Rear glass" hint="Faces the street" active={position === "rear"} onClick={() => onPosition("rear")} />
          <PositionButton label="Front display" hint="Faces the cabin" active={position === "front"} onClick={() => onPosition("front")} />
        </div>
      </div>

      <Field label="Terminal name" value={deviceName} onChange={onDeviceName} hint="Shown in the driver app" />

      {!resolution?.verified && (
        <p className="rounded-2xl border border-line bg-panel px-4 py-3 text-xs leading-relaxed text-mist">
          This browser has no record of that code, so it cannot be confirmed here. The display still pairs over the
          pairing channel — if the glass stays blank, check the code with your driver.
        </p>
      )}

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <button type="submit" disabled={busy} className="w-full rounded-2xl bg-amber py-4 font-semibold text-ink disabled:opacity-40">
        {busy ? "Assigning…" : "Assign and start the display"}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------- pieces */

function PositionButton({ label, hint, active, onClick }: { label: string; hint: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-2xl border px-4 py-4 text-left ${active ? "border-amber bg-amber/10" : "border-line bg-panel"}`}
    >
      <span className="block text-sm font-medium">{label}</span>
      <span className="mt-1 block text-[11px] text-mist">{hint}</span>
    </button>
  );
}

function BackLabel({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-[11px] tracking-[0.22em] text-mist">
      ← BACK
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  hint,
  optional,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: string;
  hint?: string;
  optional?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between text-[11px] tracking-[0.22em] text-mist">
        <span>{label.toUpperCase()}</span>
        {optional && <span className="text-[10px] tracking-[0.14em] text-mist/60">OPTIONAL</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={!optional}
        autoComplete={autoComplete}
        className="w-full rounded-2xl border border-line bg-panel px-4 py-3.5 outline-none focus:border-amber"
      />
      {hint && <span className="mt-1.5 block text-[11px] text-mist/70">{hint}</span>}
    </label>
  );
}
