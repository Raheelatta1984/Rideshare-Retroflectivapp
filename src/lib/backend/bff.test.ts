import { describe, expect, it } from "vitest";
import { createBffBackend, readBffConfig, BffError } from "./bff";
import type { TerminalAccount } from "../../types";

const account: TerminalAccount = {
  id: "user-1",
  name: "Owner",
  email: "owner@example.com",
  phone: "",
  city: "Sydney",
  pairCode: "ABC123",
  createdAt: new Date(0).toISOString(),
  source: "bff",
};

interface Call {
  url: string;
  init: RequestInit;
}

function fetchStub(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const sessionBody = { account, csrfToken: "c".repeat(43), expiresAt: Date.now() + 60_000 };

describe("readBffConfig", () => {
  it("returns null unless a same-origin base is configured", () => {
    expect(readBffConfig({})).toBeNull();
    expect(readBffConfig({ VITE_BFF_BASE: "https://bff.example.com" })).toBeNull();
    expect(readBffConfig({ VITE_BFF_BASE: "//bff.example.com" })).toBeNull();
    expect(readBffConfig({ VITE_BFF_BASE: "/bff" })).toEqual({ base: "/bff" });
    expect(readBffConfig({ VITE_BFF_BASE: "/bff/" })).toEqual({ base: "/bff" });
  });

  it("defaults to /bff when the BFF is explicitly requested", () => {
    expect(readBffConfig({ VITE_BACKEND: "bff" })).toEqual({ base: "/bff" });
  });
});

describe("createBffBackend", () => {
  it("sends credentials with every call and keeps the CSRF token out of URLs", async () => {
    const { impl, calls } = fetchStub(() => ({ body: sessionBody }));
    const backend = createBffBackend({ base: "/bff" }, impl);

    const result = await backend.accounts.signIn({ email: "owner@example.com", password: "secret" });
    expect(result.account).toEqual(account);
    expect(backend.accounts.current()).toEqual(account);

    const [call] = calls;
    expect(call.url).toBe("/bff/auth/login");
    expect(call.init.credentials).toBe("include");
    expect(call.init.cache).toBe("no-store");
    expect(JSON.stringify(call.init)).not.toContain("c".repeat(43));
  });

  it("sends the CSRF token on mutations", async () => {
    const { impl, calls } = fetchStub((url) =>
      url.endsWith("/session") ? { body: sessionBody } : { body: { campaign: { id: "camp_1" } } },
    );
    const backend = createBffBackend({ base: "/bff" }, impl);

    await backend.campaigns.upsert({
      id: "camp_1",
      title: "Campaign",
      enabled: true,
      approved: false,
      mediaType: "image",
      displaySeconds: 10,
    });

    const put = calls.find((call) => call.init.method === "PUT");
    expect(put?.url).toBe("/bff/campaigns/camp_1");
    const headers = new Headers(put?.init.headers);
    expect(headers.get("X-CSRF-Token")).toBe("c".repeat(43));
  });

  it("bootstraps the CSRF token from the session endpoint when needed", async () => {
    const { impl, calls } = fetchStub((url) =>
      url.endsWith("/session") ? { body: sessionBody } : { body: { binding: { id: "term:dev:rear" } } },
    );
    const backend = createBffBackend({ base: "/bff" }, impl);
    await backend.terminals.bind({
      deviceId: "dev-1",
      deviceName: "Tablet",
      pairCode: "ABC123",
      position: "rear",
      origin: "console",
    });
    expect(calls[0].url).toBe("/bff/session");
    expect(calls[1].url).toBe("/bff/devices");
  });

  it("maps campaign reads", async () => {
    const { impl, calls } = fetchStub(() => ({ body: { campaigns: [{ id: "camp_1" }] } }));
    const backend = createBffBackend({ base: "/bff" }, impl);
    const list = await backend.campaigns.list({ since: 1000, limit: 5 });
    expect(list).toEqual([{ id: "camp_1" }]);
    expect(calls[0].url).toBe("/bff/campaigns?since=1000&limit=5");
  });

  it("clears the cached account on a 401", async () => {
    const { impl } = fetchStub((url) => {
      if (url.endsWith("/auth/login") || url.endsWith("/session")) return { body: sessionBody };
      return { status: 401, body: { error: "Your session expired. Sign in again." } };
    });
    const backend = createBffBackend({ base: "/bff" }, impl);
    await backend.accounts.signIn({ email: "owner@example.com", password: "secret" });
    expect(backend.accounts.current()).not.toBeNull();

    await expect(backend.campaigns.list()).rejects.toBeInstanceOf(BffError);
    expect(backend.accounts.current()).toBeNull();
  });

  it("reports the server's message on a failed sign-in", async () => {
    const { impl } = fetchStub(() => ({ status: 401, body: { error: "Email or password is wrong." } }));
    const backend = createBffBackend({ base: "/bff" }, impl);
    const result = await backend.accounts.signIn({ email: "owner@example.com", password: "nope" });
    expect(result).toEqual({ account: null, error: "Email or password is wrong." });
  });

  it("resolves a pair code without adopting an account", async () => {
    const { impl } = fetchStub(() => ({ body: { code: "ABC123", position: "front", verified: true, account: null } }));
    const backend = createBffBackend({ base: "/bff" }, impl);
    const resolution = await backend.accounts.resolvePairCode("abc 123");
    expect(resolution).toEqual({ code: "ABC123", position: "front", account: null, verified: true, error: null });
    expect(backend.accounts.current()).toBeNull();
  });

  it("posts display events in the shape the server validates", async () => {
    const { impl, calls } = fetchStub(() => ({ body: { accepted: 1 } }));
    const backend = createBffBackend({ base: "/bff" }, impl);
    await backend.events.send([
      { id: "evt_1", campaignId: "camp_1", deviceId: "dev_1", kind: "proof-of-play", at: 1_700_000_000_000, dwellSeconds: 6 },
    ]);
    const payload = JSON.parse(String(calls[0].init.body)) as { events: Array<Record<string, unknown>> };
    expect(payload.events[0]).toMatchObject({ id: "evt_1", campaignId: "camp_1", kind: "proof-of-play", dwellSeconds: 6 });
  });

  it("keeps manifest keys on the server", async () => {
    const { impl, calls } = fetchStub((url) => {
      if (url.endsWith("/session")) return { body: sessionBody };
      if (url.endsWith("/manifest/verify")) return { body: { valid: true } };
      return { body: { manifest: { version: 2, issuedAt: 1, entries: [], signature: "abc" } } };
    });
    const backend = createBffBackend({ base: "/bff" }, impl);
    const manifest = await backend.manifest.issue([]);
    expect(manifest.signature).toBe("abc");
    expect(calls[0].url).toBe("/bff/session"); // CSRF bootstrap
    expect(await backend.manifest.verify(manifest)).toEqual({ valid: true });
  });

  it("describes itself as a session-service backend", () => {
    const backend = createBffBackend({ base: "/bff" }, fetch);
    expect(backend.info()).toMatchObject({ kind: "bff", configured: true });
  });
});
