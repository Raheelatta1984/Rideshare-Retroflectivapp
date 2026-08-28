import { useState } from "react";
import { Logo } from "./Logo";
import { useStore } from "../store";

export function Auth({ mode, go }: { mode: "login" | "signup"; go: (p: string) => void }) {
  const { login, signup } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    city: "",
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const err =
      mode === "login"
        ? login(form.email, form.password)
        : signup({ name: form.name, email: form.email, password: form.password, phone: form.phone, city: form.city });
    if (err) setError(err);
    else go(mode === "signup" ? "/onboarding" : "/app");
  };

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="grid min-h-dvh bg-ink lg:grid-cols-2">
      <div className="relative hidden overflow-hidden lg:block">
        <img src="https://images.pexels.com/photos/16158304/pexels-photo-16158304.jpeg?auto=compress&cs=tinysrgb&w=1600" alt="" className="h-full w-full object-cover opacity-60" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/30 to-transparent" />
        <div className="absolute bottom-10 left-10 right-10">
          <p className="text-[11px] tracking-[0.4em] text-amber">DRIVER BOOTH</p>
          <p className="mt-3 max-w-md font-display text-4xl">One console. Every curb. A tablet that only speaks when it should.</p>
        </div>
      </div>
      <div className="flex flex-col justify-center px-6 py-16 md:px-16">
        <button onClick={() => go("/")} className="mb-10 w-fit">
          <Logo />
        </button>
        <h1 className="font-display text-4xl">{mode === "login" ? "Back in the booth." : "Open a booth."}</h1>
        <p className="mt-2 text-sm text-mist">
          {mode === "login" ? "Use your driver, supervisor, or administrator account to enter the booth." : "Takes a minute. Pair the tablet after."}
        </p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          {mode === "signup" && (
            <Field label="Full name" value={form.name} onChange={(v) => set("name", v)} />
          )}
          <Field label="Email" type="email" value={form.email} onChange={(v) => set("email", v)} />
          <div>
            <Field label="Password" type="password" value={form.password} onChange={(v) => set("password", v)} />
            {mode === "login" && <button type="button" onClick={() => go("/forgot-password")} className="mt-2 text-xs text-amber hover:text-cream">Forgot password?</button>}
          </div>
          {mode === "signup" && (
            <>
              <Field label="Phone" value={form.phone} onChange={(v) => set("phone", v)} />
              <Field label="City" value={form.city} onChange={(v) => set("city", v)} />
            </>
          )}
          {error && <p className="text-sm text-rose-400">{error}</p>}
          <button type="submit" className="w-full rounded-2xl bg-amber py-3.5 font-semibold text-ink">
            {mode === "login" ? "Enter console" : "Create booth"}
          </button>
        </form>
        <p className="mt-6 text-sm text-mist">
          {mode === "login" ? (
            <>
              New driver?{" "}
              <button onClick={() => go("/signup")} className="text-cream underline">
                Create a booth
              </button>
            </>
          ) : (
            <>
              Already driving?{" "}
              <button onClick={() => go("/login")} className="text-cream underline">
                Log in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] tracking-[0.22em] text-mist">{label.toUpperCase()}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="w-full rounded-2xl border border-line bg-panel px-4 py-3 outline-none focus:border-amber"
      />
    </label>
  );
}
