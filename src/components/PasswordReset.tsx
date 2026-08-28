import { useEffect, useState } from "react";
import { ArrowLeft, KeyRound, Mail, ShieldCheck } from "lucide-react";
import { Logo } from "./Logo";
import { useStore } from "../store";

export function ForgotPassword({ go }: { go: (path: string) => void }) {
  const { requestPasswordReset } = useStore();
  const [email, setEmail] = useState("");
  const [requested, setRequested] = useState<{ recipient: string; emailHref: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const result = requestPasswordReset(email.trim());
    if (result.error || !result.recipient || !result.emailHref) {
      setError(result.error ?? "Could not create a verification code.");
      setRequested(null);
      return;
    }
    setError(null);
    setRequested({ recipient: result.recipient, emailHref: result.emailHref });
  };

  return (
    <div className="min-h-dvh bg-ink px-6 py-10 text-cream">
      <div className="mx-auto max-w-lg">
        <button onClick={() => go("/login")} className="inline-flex items-center gap-2 text-sm text-mist hover:text-cream"><ArrowLeft className="h-4 w-4" /> Back to login</button>
        <div className="mt-10"><Logo /></div>
        <p className="mt-10 text-[11px] tracking-[0.4em] text-amber">ACCOUNT RECOVERY</p>
        <h1 className="mt-3 font-display text-4xl">Verify your email.</h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-mist">Enter your registered account email. A unique six-digit verification code must be sent to and read from that email before a password can be changed.</p>
        <form onSubmit={submit} className="mt-7 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-[11px] tracking-[0.22em] text-mist">ACCOUNT EMAIL</span>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required className="w-full rounded-2xl border border-line bg-panel px-4 py-3 outline-none focus:border-amber" placeholder="you@example.com" />
          </label>
          <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-amber py-3.5 font-semibold text-ink"><Mail className="h-4 w-4" /> Send verification code</button>
        </form>
        {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}
        {requested && (
          <section className="mt-7 rounded-3xl border border-amber/30 bg-panel p-5">
            <div className="flex items-center gap-2 text-amber"><ShieldCheck className="h-4 w-4" /><p className="text-[11px] tracking-[0.28em]">CODE CONFIRMATION REQUIRED</p></div>
            <p className="mt-3 text-sm leading-relaxed text-mist">A six-digit code has been prepared for <span className="text-cream">{requested.recipient}</span>. Send the email, read the code from the inbox, then enter it here. The app never displays the code directly.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a href={requested.emailHref} className="inline-flex items-center gap-2 rounded-xl bg-cream px-4 py-2.5 text-sm font-semibold text-ink"><Mail className="h-4 w-4" /> Open email app</a>
              <button onClick={() => go(`/verify-reset?email=${encodeURIComponent(requested.recipient)}`)} className="inline-flex items-center gap-2 rounded-xl bg-amber px-4 py-2.5 text-sm font-semibold text-ink"><KeyRound className="h-4 w-4" /> Enter verification code</button>
            </div>
          </section>
        )}
        <p className="mt-8 text-xs leading-relaxed text-mist">Local browser mode: codes expire in 30 minutes and are saved only in this browser cache. A production email service requires a server-side database and email provider.</p>
      </div>
    </div>
  );
}

export function VerifyResetCode({ email, go }: { email: string; go: (path: string) => void }) {
  const { verifyPasswordResetCode } = useStore();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const result = verifyPasswordResetCode(email, code);
    if (result.error || !result.token) {
      setError(result.error ?? "Invalid verification code.");
      return;
    }
    go(`/reset-password?token=${encodeURIComponent(result.token)}`);
  };
  return (
    <div className="min-h-dvh bg-ink px-6 py-10 text-cream">
      <div className="mx-auto max-w-lg">
        <button onClick={() => go("/forgot-password")} className="inline-flex items-center gap-2 text-sm text-mist hover:text-cream"><ArrowLeft className="h-4 w-4" /> Back</button>
        <div className="mt-10"><Logo /></div>
        <p className="mt-10 text-[11px] tracking-[0.4em] text-amber">EMAIL VERIFICATION</p>
        <h1 className="mt-3 font-display text-4xl">Enter six-digit code.</h1>
        <p className="mt-3 text-sm text-mist">Check the inbox for <span className="text-cream">{email}</span>. Random codes are rejected. Five incorrect attempts invalidate the code.</p>
        <form onSubmit={submit} className="mt-7 space-y-4">
          <input autoFocus inputMode="numeric" pattern="[0-9]*" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="123456" required className="w-full rounded-2xl border border-line bg-panel px-4 py-4 text-center font-cond text-4xl tracking-[0.32em] outline-none focus:border-amber" />
          {error && <p className="text-sm text-rose-400">{error}</p>}
          <button type="submit" disabled={code.length !== 6} className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-amber py-3.5 font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40"><ShieldCheck className="h-4 w-4" /> Verify code</button>
        </form>
      </div>
    </div>
  );
}

export function ResetPassword({ token, go }: { token: string; go: (path: string) => void }) {
  const { resetPassword, validatePasswordReset } = useStore();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
  useEffect(() => {
    const reset = validatePasswordReset(token);
    setVerifiedEmail(reset?.email ?? null);
  }, [token, validatePasswordReset]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!verifiedEmail) return setError("This code verification is invalid or expired.");
    if (password !== confirm) return setError("Passwords do not match.");
    const result = resetPassword(token, password);
    if (result) return setError(result);
    window.history.replaceState({}, "", window.location.pathname);
    go("/login");
  };
  return (
    <div className="min-h-dvh bg-ink px-6 py-10 text-cream">
      <div className="mx-auto max-w-lg">
        <div><Logo /></div>
        <p className="mt-10 text-[11px] tracking-[0.4em] text-amber">EMAIL CODE VERIFIED</p>
        <h1 className="mt-3 font-display text-4xl">Choose a new password.</h1>
        {verifiedEmail ? <p className="mt-3 text-sm text-mist">Verified account: <span className="text-cream">{verifiedEmail}</span>.</p> : <p className="mt-3 text-sm text-rose-400">This reset authorization is invalid or expired.</p>}
        <form onSubmit={submit} className="mt-7 space-y-4">
          <label className="block"><span className="mb-1.5 block text-[11px] tracking-[0.22em] text-mist">NEW PASSWORD</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} className="w-full rounded-2xl border border-line bg-panel px-4 py-3 outline-none focus:border-amber" /></label>
          <label className="block"><span className="mb-1.5 block text-[11px] tracking-[0.22em] text-mist">CONFIRM PASSWORD</span><input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required minLength={8} className="w-full rounded-2xl border border-line bg-panel px-4 py-3 outline-none focus:border-amber" /></label>
          {error && <p className="text-sm text-rose-400">{error}</p>}
          <button type="submit" disabled={!verifiedEmail} className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-amber py-3.5 font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40"><KeyRound className="h-4 w-4" /> Save verified password</button>
        </form>
      </div>
    </div>
  );
}