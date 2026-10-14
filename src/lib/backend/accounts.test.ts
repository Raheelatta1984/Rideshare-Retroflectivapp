import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalBackend } from "./local";
import { createSupabaseBackend } from "./supabase";
import { db } from "../storage";
import { readLocalBinding } from "../terminals";

/**
 * Terminal accounts + the terminal registry.
 *
 * The local adapter is what ships today; the Supabase adapter is the same
 * contract against a shared project. Both are exercised here so swapping
 * VITE_BACKEND never changes what the sign-up screens can rely on.
 */

beforeEach(() => {
  localStorage.clear();
});

const signUpInput = {
  name: "Raheel Atta",
  email: "terminal@retroflex.app",
  password: "demo12345",
  phone: "0400 111 222",
  city: "Sydney",
};

/* ------------------------------------------------------------------ *
 * Local adapter
 * ------------------------------------------------------------------ */

describe("local accounts", () => {
  it("creates a booth with its own rear and front codes", async () => {
    const result = await createLocalBackend().accounts.signUp(signUpInput);

    expect(result.error).toBeNull();
    expect(result.account?.pairCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(result.account?.frontPairCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(result.account?.frontPairCode).not.toBe(result.account?.pairCode);
    expect(result.account?.source).toBe("local");
    // The password never leaves the storage layer.
    expect(result.account).not.toHaveProperty("password");
    // One account model: the terminal sign-up is a booth the console can open.
    expect(db.findByEmail(signUpInput.email)?.pairCode).toBe(result.account?.pairCode);
    expect(db.getSession()?.driverId).toBe(result.account?.id);
  });

  it("refuses a duplicate email, a weak password and a bad address", async () => {
    const backend = createLocalBackend();
    await backend.accounts.signUp(signUpInput);

    expect((await backend.accounts.signUp(signUpInput)).error).toMatch(/already exists/i);
    expect((await backend.accounts.signUp({ ...signUpInput, email: "other@retroflex.app", password: "short" })).error).toMatch(/8 characters/i);
    expect((await backend.accounts.signUp({ ...signUpInput, email: "nope@", password: "demo12345" })).error).toMatch(/email/i);
    expect((await backend.accounts.signUp({ ...signUpInput, email: "name@retroflex.app", name: "R" })).error).toMatch(/name/i);
  });

  it("signs in with the right password only", async () => {
    const backend = createLocalBackend();
    await backend.accounts.signUp(signUpInput);
    await backend.accounts.signOut();
    expect(backend.accounts.current()).toBeNull();

    const wrong = await backend.accounts.signIn({ email: signUpInput.email, password: "wrong-one" });
    expect(wrong.account).toBeNull();
    expect(wrong.error).toMatch(/wrong/i);

    const right = await backend.accounts.signIn({ email: signUpInput.email.toUpperCase(), password: signUpInput.password });
    expect(right.error).toBeNull();
    expect(backend.accounts.current()?.email).toBe(signUpInput.email);
  });

  it("resolves a pair code to the booth and the glass that owns it", async () => {
    const backend = createLocalBackend();
    const { account } = await backend.accounts.signUp(signUpInput);

    const rear = await backend.accounts.resolvePairCode(account!.pairCode);
    expect(rear).toMatchObject({ verified: true, position: "rear", error: null });
    expect(rear.account?.email).toBe(signUpInput.email);

    const front = await backend.accounts.resolvePairCode(account!.frontPairCode!.toLowerCase());
    expect(front).toMatchObject({ verified: true, position: "front" });
  });

  it("does not invent an account for a code it has never seen", async () => {
    // Honest degradation: the code still pairs over the sync channel, but the
    // adapter must not claim it confirmed anything.
    const resolution = await createLocalBackend().accounts.resolvePairCode("QQQ999");
    expect(resolution).toMatchObject({ verified: false, account: null, error: null });
  });

  it("rejects a code that is not six characters", async () => {
    const resolution = await createLocalBackend().accounts.resolvePairCode("7K2");
    expect(resolution.error).toMatch(/six characters/i);
    expect(resolution.verified).toBe(false);
  });
});

describe("local terminal registry", () => {
  const bind = (backend = createLocalBackend(), overrides: Record<string, unknown> = {}) =>
    backend.terminals.bind({
      deviceId: "tab_pixel",
      deviceName: "Rear glass · Android 14",
      pairCode: "7K2M9Q",
      position: "rear",
      accountId: "drv_1",
      accountEmail: "driver@retroflex.app",
      origin: "pair-code",
      ...overrides,
    } as Parameters<typeof backend.terminals.bind>[0]);

  it("records the assignment on the device so a reload skips sign-up", async () => {
    const binding = await bind();
    expect(binding).toMatchObject({ id: "term:tab_pixel:rear", pairCode: "7K2M9Q", position: "rear", accountId: "drv_1" });
    expect(readLocalBinding()?.id).toBe(binding.id);
    expect(await createLocalBackend().terminals.find("tab_pixel")).toMatchObject({ pairCode: "7K2M9Q" });
  });

  it("keeps one binding per physical terminal when it moves to the front glass", async () => {
    const backend = createLocalBackend();
    await bind(backend);
    await bind(backend, { position: "front", deviceName: "Front display" });

    const all = await backend.terminals.list("drv_1");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ position: "front", deviceName: "Front display" });
    expect(readLocalBinding()?.position).toBe("front");
  });

  it("scopes the list to one booth and orders newest first", async () => {
    const backend = createLocalBackend();
    await bind(backend, { deviceId: "tab_a", accountId: "drv_1" });
    await bind(backend, { deviceId: "tab_b", accountId: "drv_2" });

    expect((await backend.terminals.list("drv_1")).map((item) => item.deviceId)).toEqual(["tab_a"]);
    expect(await backend.terminals.list()).toHaveLength(2);
  });

  it("heartbeats and releases", async () => {
    const backend = createLocalBackend();
    const binding = await bind(backend);

    await backend.terminals.touch(binding.id);
    const touched = await backend.terminals.find("tab_pixel");
    expect(touched?.lastSeen).toBeGreaterThanOrEqual(binding.assignedAt);

    await backend.terminals.unbind(binding.id);
    expect(await backend.terminals.find("tab_pixel")).toBeNull();
    expect(readLocalBinding()).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Supabase adapter — REST contract, against a fake fetch
 * ------------------------------------------------------------------ */

const config = { url: "https://demo.supabase.co", anonKey: "anon-key", bucket: "campaigns" };

const boothRow = {
  id: "booth_1",
  owner: "usr_1",
  name: "Raheel Atta",
  email: "driver@retroflex.app",
  phone: null,
  city: "Sydney",
  pair_code: "7K2M9Q",
  front_pair_code: "FR0NT1",
  created_at: "2026-01-01T00:00:00Z",
};

const session = {
  access_token: "tok_1",
  refresh_token: "ref_1",
  user: { id: "usr_1", email: "driver@retroflex.app", user_metadata: { name: "Raheel Atta" } },
};

function fakeSupabase(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined, auth: headers.Authorization });
    const { status = 200, body = [] } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("supabase accounts", () => {
  it("signs up through Supabase Auth, then mints a booth with fresh codes", async () => {
    const { fetchImpl, calls } = fakeSupabase((url, init) => {
      if (url.includes("/auth/v1/signup")) return { body: session };
      if (url.includes("booths") && init?.method === "POST") return { body: [boothRow] };
      if (url.includes("booths")) return { body: [] };
      return { body: [] };
    });

    const result = await createSupabaseBackend(config, fetchImpl).accounts.signUp(signUpInput);

    expect(result.error).toBeNull();
    expect(result.account).toMatchObject({ id: "usr_1", pairCode: "7K2M9Q", frontPairCode: "FR0NT1", source: "supabase" });
    expect(calls[0].url).toContain("/auth/v1/signup");
    expect(calls.some((call) => call.url.includes("/rest/v1/booths") && call.method === "POST")).toBe(true);
    // The booth insert carries the pair codes, which is what makes a code
    // resolvable from the driver's phone later.
    const insert = calls.find((call) => call.url.includes("/rest/v1/booths") && call.method === "POST");
    expect(insert?.body).toContain("pair_code");
    expect(createSupabaseBackend(config, fetchImpl).accounts.current()?.email).toBe("driver@retroflex.app");
  });

  it("reports an email that is already registered", async () => {
    // GoTrue answers 200 with an empty identities array instead of a 409.
    const { fetchImpl } = fakeSupabase(() => ({ body: { ...session, access_token: undefined, identities: [] } }));
    const result = await createSupabaseBackend(config, fetchImpl).accounts.signUp(signUpInput);
    expect(result.account).toBeNull();
    expect(result.error).toMatch(/already exists/i);
  });

  it("says when a confirmation email has to be opened first", async () => {
    const { fetchImpl } = fakeSupabase(() => ({ body: { id: "usr_1", email: signUpInput.email, confirmation_sent_at: "2026-01-01" } }));
    const result = await createSupabaseBackend(config, fetchImpl).accounts.signUp(signUpInput);
    expect(result.error).toMatch(/confirmation email/i);
  });

  it("translates GoTrue's credential error into the message the screen shows", async () => {
    const { fetchImpl } = fakeSupabase((url) =>
      url.includes("/auth/v1/token") ? { status: 400, body: { error: "invalid_grant", error_description: "Invalid login credentials" } } : { body: [] },
    );
    const result = await createSupabaseBackend(config, fetchImpl).accounts.signIn({ email: signUpInput.email, password: "wrong" });
    expect(result.error).toBe("Email or password is wrong.");
  });

  it("confirms a code from the anon directory view, which carries no contact details", async () => {
    const { fetchImpl, calls } = fakeSupabase((url) =>
      url.includes("booth_directory") ? { body: [{ ...boothRow, email: undefined }] } : { body: [] },
    );

    const resolution = await createSupabaseBackend(config, fetchImpl).accounts.resolvePairCode("fr0nt1");

    expect(resolution).toMatchObject({ code: "FR0NT1", verified: true, position: "front" });
    expect(resolution.account?.name).toBe("Raheel Atta");
    expect(resolution.account?.email).toBe("");
    expect(calls[0].url).toContain("booth_directory");
    expect(calls[0].url).toContain("or=(pair_code.eq.FR0NT1,front_pair_code.eq.FR0NT1)");
    expect(calls[0].url).not.toContain("/booths?");
  });

  it("degrades to the device when migration 0003 has not been applied", async () => {
    const { fetchImpl } = fakeSupabase((url) => (url.includes("booth_directory") ? { status: 404, body: { message: "relation not found" } } : { body: [] }));
    const resolution = await createSupabaseBackend(config, fetchImpl).accounts.resolvePairCode("7K2M9Q");
    expect(resolution).toMatchObject({ verified: false, account: null, error: null });
  });
});

describe("supabase terminal registry", () => {
  const signedIn = () => {
    const { fetchImpl, calls } = fakeSupabase((url, init) => {
      if (url.includes("/auth/v1/token")) return { body: session };
      if (url.includes("booths") && init?.method === "POST") return { body: [boothRow] };
      if (url.includes("booths")) return { body: [] };
      return { body: [] };
    });
    return { backend: createSupabaseBackend(config, fetchImpl), fetchImpl, calls };
  };

  it("writes the terminal into the devices table under its owner", async () => {
    const { backend, calls } = signedIn();
    await backend.accounts.signIn({ email: "driver@retroflex.app", password: "demo12345" });

    const binding = await backend.terminals.bind({
      deviceId: "tab_pixel",
      deviceName: "Rear glass · Android 14",
      pairCode: "7k2m9q",
      position: "rear",
      origin: "pair-code",
    });

    expect(binding).toMatchObject({ pairCode: "7K2M9Q", accountId: "usr_1", accountEmail: "driver@retroflex.app" });
    const insert = calls.find((call) => call.url.includes("/rest/v1/devices"));
    expect(insert?.url).toContain("on_conflict=id");
    expect(insert?.body).toContain('"device_key":"tab_pixel"');
    expect(insert?.body).toContain('"owner":"usr_1"');
    expect(insert?.auth).toBe("Bearer tok_1");
  });

  it("keeps an anonymous binding on the terminal instead of writing a row nobody owns", async () => {
    const { fetchImpl, calls } = fakeSupabase(() => ({ body: [] }));
    const backend = createSupabaseBackend(config, fetchImpl);

    const binding = await backend.terminals.bind({
      deviceId: "tab_pixel",
      deviceName: "Rear glass",
      pairCode: "7K2M9Q",
      position: "rear",
      origin: "pair-code",
    });

    expect(binding).toMatchObject({ pairCode: "7K2M9Q", accountId: null });
    expect(calls.filter((call) => call.url.includes("/rest/v1/devices"))).toHaveLength(0);
    expect(readLocalBinding()?.deviceId).toBe("tab_pixel");
  });

  it("retries the device insert without the 0003 columns on an older project", async () => {
    let devicePosts = 0;
    const { fetchImpl, calls } = fakeSupabase((url, init) => {
      if (url.includes("/auth/v1/token")) return { body: session };
      if (url.includes("booths")) return { body: init?.method === "POST" ? [boothRow] : [] };
      if (url.includes("/rest/v1/devices")) {
        devicePosts += 1;
        // A project that has not run 0003 rejects the unknown columns.
        return devicePosts === 1 ? { status: 400, body: { message: "column device_key does not exist" } } : { body: [{}] };
      }
      return { body: [] };
    });

    const backend = createSupabaseBackend(config, fetchImpl);
    await backend.accounts.signIn({ email: "driver@retroflex.app", password: "demo12345" });
    const binding = await backend.terminals.bind({
      deviceId: "tab_pixel",
      deviceName: "Rear glass",
      pairCode: "7K2M9Q",
      position: "rear",
      origin: "signup",
    });

    expect(devicePosts).toBe(2);
    expect(binding.pairCode).toBe("7K2M9Q");
    const retry = calls.filter((call) => call.url.includes("/rest/v1/devices")).pop();
    // Every 0003 column is dropped together: PostgREST rejects unknown columns,
    // so a partial payload would fail the same way.
    expect(retry?.body).not.toContain("device_key");
    expect(retry?.body).not.toContain("origin");
    expect(retry?.body).toContain('"pair_code":"7K2M9Q"');
  });
});
