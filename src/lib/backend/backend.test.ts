import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalBackend } from "./local";
import { createSupabaseBackend, readSupabaseConfig, dataUrlToBlob } from "./supabase";
import { EventQueue } from "./queue";
import type { Backend, CampaignEventRecord } from "./types";
import type { CommercialCampaign } from "../../types";

const campaign = (overrides: Partial<CommercialCampaign> = {}): CommercialCampaign => ({
  id: "cmp_1",
  title: "Bondi Coffee",
  enabled: true,
  approved: true,
  assetDataUrl: "data:image/png;base64,AAAA",
  mediaType: "image",
  displaySeconds: 10,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
});

/* ------------------------------------------------------------------ *
 * Local adapter
 * ------------------------------------------------------------------ */

describe("local backend — campaigns", () => {
  it("upserts, lists and removes", async () => {
    const backend = createLocalBackend();
    await backend.campaigns.upsert(campaign());
    await backend.campaigns.upsert(campaign({ id: "cmp_2", title: "Second" }));

    expect((await backend.campaigns.list()).map((c) => c.id).sort()).toEqual(["cmp_1", "cmp_2"]);

    await backend.campaigns.remove("cmp_1");
    expect((await backend.campaigns.list()).map((c) => c.id)).toEqual(["cmp_2"]);
  });

  it("stamps updatedAt on write so change polling works", async () => {
    const backend = createLocalBackend();
    const saved = await backend.campaigns.upsert(campaign({ updatedAt: 1 }));
    expect(saved.updatedAt).toBeGreaterThan(1);
    expect((await backend.campaigns.list({ since: 2 })).map((c) => c.id)).toEqual(["cmp_1"]);
  });

  it("returns null for a missing campaign", async () => {
    const backend = createLocalBackend();
    expect(await backend.campaigns.get("nope")).toBeNull();
  });

  // The approval workflow is the Phase 2 addition to the campaign lifecycle.
  it("records an approval decision and keeps the legacy flag in step", async () => {
    const backend = createLocalBackend();
    await backend.campaigns.upsert(campaign({ approved: false }));

    const approved = await backend.campaigns.setApproval("cmp_1", "approved", "Raheel", "looks good");
    expect(approved?.approval).toMatchObject({ state: "approved", reviewer: "Raheel", note: "looks good" });
    expect(approved?.approved).toBe(true);

    const rejected = await backend.campaigns.setApproval("cmp_1", "rejected", "Raheel", "unapproved logo");
    expect(rejected?.approved).toBe(false);
    expect(rejected?.approval?.note).toBe("unapproved logo");
  });

  it("returns null when approving something that does not exist", async () => {
    const backend = createLocalBackend();
    expect(await backend.campaigns.setApproval("ghost", "approved", "Raheel")).toBeNull();
  });
});

describe("local backend — assets", () => {
  it("stores a blob and returns a renderable data URL", async () => {
    const backend = createLocalBackend();
    const stored = await backend.assets.put({
      campaignId: "cmp_1",
      filename: "coffee.png",
      contentType: "image/png",
      data: new Blob(["pixels"], { type: "image/png" }),
    });
    expect(stored.path).toBe("cmp_1/coffee.png");
    expect(stored.url.startsWith("data:")).toBe(true);
    expect(await backend.assets.signedUrl("cmp_1/coffee.png")).toBe(stored.url);
  });

  it("throws for an unknown asset path", async () => {
    const backend = createLocalBackend();
    await expect(backend.assets.signedUrl("missing.png")).rejects.toThrow(/not found/i);
  });

  it("removes assets", async () => {
    const backend = createLocalBackend();
    await backend.assets.put({ campaignId: "c", filename: "a.png", contentType: "image/png", data: "data:image/png;base64,AAAA" });
    await backend.assets.remove("c/a.png");
    await expect(backend.assets.signedUrl("c/a.png")).rejects.toThrow();
  });
});

describe("local backend — events and subscribe", () => {
  it("stores events newest first", async () => {
    const backend = createLocalBackend();
    await backend.events.send([
      { id: "e1", campaignId: "cmp_1", deviceId: "tab_1", kind: "proof-of-play", at: 1 },
      { id: "e2", campaignId: "cmp_1", deviceId: "tab_1", kind: "qr-scan", at: 2 },
    ]);
    const list = await backend.events.list();
    expect(list.map((e) => e.id)).toEqual(["e2", "e1"]);
  });

  it("notifies subscribers on change and stops after unsubscribe", async () => {
    const backend = createLocalBackend();
    const onChange = vi.fn();
    const stop = backend.subscribe(onChange);

    await backend.campaigns.upsert(campaign());
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    await backend.campaigns.upsert(campaign({ title: "Changed again" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reports itself as configured", () => {
    const info = createLocalBackend().info();
    expect(info.kind).toBe("local");
    expect(info.configured).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Supabase adapter (against a fake fetch)
 * ------------------------------------------------------------------ */

function fakeBackend(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
    const { status = 200, body = [] } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const config = { url: "https://demo.supabase.co", anonKey: "anon-key", bucket: "campaigns" };

describe("readSupabaseConfig", () => {
  it("returns null when env vars are missing or placeholders", () => {
    expect(readSupabaseConfig({})).toBeNull();
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: "https://x.supabase.co" })).toBeNull();
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: "$VITE_SUPABASE_URL", VITE_SUPABASE_ANON_KEY: "k" })).toBeNull();
  });

  it("reads a full config and defaults the bucket", () => {
    const parsed = readSupabaseConfig({ VITE_SUPABASE_URL: "https://x.supabase.co/", VITE_SUPABASE_ANON_KEY: "k" });
    expect(parsed).toMatchObject({ url: "https://x.supabase.co", anonKey: "k", bucket: "campaigns" });
  });
});

describe("supabase backend — REST contract", () => {
  it("sends the anon key on every request", async () => {
    const { fetchImpl, calls } = fakeBackend(() => ({ body: [] }));
    await createSupabaseBackend(config, fetchImpl).campaigns.list();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/rest/v1/campaigns");
  });

  it("unwraps campaigns from their payload column and orders by updated_at", async () => {
    const { fetchImpl, calls } = fakeBackend(() => ({
      body: [{ id: "cmp_1", payload: campaign(), updated_at: "2026-01-01T00:00:00Z", approval_state: "approved" }],
    }));
    const list = await createSupabaseBackend(config, fetchImpl).campaigns.list();
    expect(list[0].title).toBe("Bondi Coffee");
    expect(calls[0].url).toContain("order=updated_at.desc");
  });

  it("filters by change time for cheap polling", async () => {
    const { fetchImpl, calls } = fakeBackend(() => ({ body: [] }));
    await createSupabaseBackend(config, fetchImpl).campaigns.list({ since: Date.UTC(2026, 0, 1) });
    expect(decodeURIComponent(calls[0].url)).toContain("updated_at=gt.2026-01-01");
  });

  it("upserts with merge-duplicates so re-saves don't 409", async () => {
    const { fetchImpl, calls } = fakeBackend(() => ({ body: [{}] }));
    await createSupabaseBackend(config, fetchImpl).campaigns.upsert(campaign());
    expect(calls[0].url).toContain("on_conflict=id");
    expect(String((calls[0] as { url: string }).url)).toContain("campaigns");
    expect(calls[0].method).toBe("POST");
  });

  it("writes an approval and an audit row", async () => {
    const { fetchImpl, calls } = fakeBackend((url) => (url.includes("select=") ? { body: [{ payload: campaign() }] } : { body: [{}] }));
    const updated = await createSupabaseBackend(config, fetchImpl).campaigns.setApproval("cmp_1", "approved", "Raheel", "ok");
    expect(updated?.approval?.state).toBe("approved");
    expect(calls.some((c) => c.url.includes("approval_audit"))).toBe(true);
  });

  it("surfaces API errors instead of swallowing them", async () => {
    const { fetchImpl } = fakeBackend(() => ({ status: 401, body: { message: "bad key" } }));
    await expect(createSupabaseBackend(config, fetchImpl).campaigns.list()).rejects.toThrow(/Supabase 401/);
  });

  it("uploads assets to the bucket path and returns a public URL", async () => {
    const { fetchImpl, calls } = fakeBackend(() => ({ body: {} }));
    const stored = await createSupabaseBackend(config, fetchImpl).assets.put({
      campaignId: "cmp_1",
      filename: "coffee.png",
      contentType: "image/png",
      data: new Blob(["x"], { type: "image/png" }),
    });
    expect(calls[0].url).toContain("/storage/v1/object/campaigns/cmp_1/coffee.png");
    expect(stored.url).toBe("https://demo.supabase.co/storage/v1/object/public/campaigns/cmp_1/coffee.png");
  });

  it("maps event rows back into the app shape", async () => {
    const { fetchImpl } = fakeBackend(() => ({
      body: [
        { id: "e1", campaign_id: "cmp_1", device_id: "tab_1", pair_code: "7K2M9Q", kind: "qr-scan", at: "2026-01-01T00:00:00Z", dwell_seconds: 10, meta: { title: "x" } },
      ],
    }));
    const events = await createSupabaseBackend(config, fetchImpl).events.list();
    expect(events[0]).toMatchObject({ campaignId: "cmp_1", kind: "qr-scan", pairCode: "7K2M9Q" });
    expect(typeof events[0].at).toBe("number");
  });

  it("rejects when the event API fails, so the queue can retry", async () => {
    const { fetchImpl } = fakeBackend(() => ({ status: 500, body: {} }));
    await expect(
      createSupabaseBackend(config, fetchImpl).events.send([
        { id: "e1", campaignId: "c", deviceId: "d", kind: "proof-of-play", at: 1 },
      ]),
    ).rejects.toThrow();
  });

  it("polls on the subscribe contract", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = fakeBackend(() => ({ body: [] }));
    const backend = createSupabaseBackend(config, fetchImpl);
    const onChange = vi.fn();
    const stop = backend.subscribe(onChange, { pollMs: 1000 });
    vi.advanceTimersByTime(3000);
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(3000);
    expect(onChange).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("dataUrlToBlob", () => {
  it("decodes a base64 data URL into the right content type", () => {
    const blob = dataUrlToBlob("data:image/png;base64,QUJD");
    expect(blob.type).toBe("image/png");
  });
});

/* ------------------------------------------------------------------ *
 * Event queue
 * ------------------------------------------------------------------ */

function memorySink() {
  const sent: CampaignEventRecord[][] = [];
  let failures = 0;
  const sink = {
    async send(batch: CampaignEventRecord[]) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("offline");
      }
      sent.push(batch);
    },
    async list() {
      return sent.flat();
    },
  };
  return { sink, sent, failNext: (n: number) => (failures = n) };
}

function fakeBackendWith(sink: ReturnType<typeof memorySink>["sink"]): Backend {
  // Spread the real local adapter and swap the event sink only. Building the
  // object literal by hand goes stale every time Backend grows a repository
  // (accounts/terminals did exactly that), and the queue under test never
  // touches the other members.
  return { ...createLocalBackend(), events: sink };
}

describe("EventQueue", () => {
  it("batches proof-of-play events and flushes them", async () => {
    const { sink, sent } = memorySink();
    const queue = new EventQueue({ backend: fakeBackendWith(sink), flushMs: 0 });
    queue.proofOfPlay({ campaignId: "cmp_1", deviceId: "tab_1", dwellSeconds: 10, title: "Bondi" });
    queue.proofOfPlay({ campaignId: "cmp_1", deviceId: "tab_1", dwellSeconds: 10 });

    expect(queue.size).toBe(2);
    const result = await queue.flush();
    expect(result.sent).toBe(2);
    expect(queue.size).toBe(0);
    expect(sent[0][0]).toMatchObject({ kind: "proof-of-play", campaignId: "cmp_1" });
    expect(sent[0][0].meta).toEqual({ title: "Bondi" });
  });

  // The tablet loses signal mid-trip; a failed batch must survive and retry.
  it("keeps events queued when the send fails, then succeeds on retry", async () => {
    const { sink, sent, failNext } = memorySink();
    const queue = new EventQueue({ backend: fakeBackendWith(sink), flushMs: 0, maxAttempts: 5 });
    queue.record({ campaignId: "c", deviceId: "d", kind: "qr-scan" });

    failNext(1);
    expect((await queue.flush()).sent).toBe(0);
    expect(queue.size).toBe(1);
    expect(queue.stats.failed).toBe(1);

    expect((await queue.flush()).sent).toBe(1);
    expect(queue.size).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("drops only what has exhausted its retries", async () => {
    const { sink } = memorySink();
    const queue = new EventQueue({ backend: fakeBackendWith(sink), flushMs: 0, maxAttempts: 2 });
    queue.record({ campaignId: "c", deviceId: "d", kind: "proof-of-play" });

    const failing = { async send() { throw new Error("down"); }, async list() { return []; } };
    const dead = new EventQueue({ backend: fakeBackendWith(failing), flushMs: 0, maxAttempts: 2 });
    dead.record({ campaignId: "c", deviceId: "d", kind: "proof-of-play" });

    await dead.flush();
    expect(dead.size).toBe(1);
    await dead.flush();
    expect(dead.size).toBe(0);
    expect(dead.stats.dropped).toBe(1);
  });

  it("caps the queue so it can never grow without bound", () => {
    const { sink } = memorySink();
    const queue = new EventQueue({ backend: fakeBackendWith(sink), flushMs: 0, maxQueue: 3 });
    for (let i = 0; i < 10; i += 1) queue.record({ campaignId: `c${i}`, deviceId: "d", kind: "proof-of-play" });
    expect(queue.size).toBe(3);
    expect(queue.stats.dropped).toBe(7);
    expect(queue.peek()[0].campaignId).toBe("c7");
  });

  it("auto-flushes when the batch size is reached", async () => {
    const { sink, sent } = memorySink();
    const queue = new EventQueue({ backend: fakeBackendWith(sink), flushMs: 0, batchSize: 2 });
    queue.record({ campaignId: "c1", deviceId: "d", kind: "proof-of-play" });
    queue.record({ campaignId: "c2", deviceId: "d", kind: "proof-of-play" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent[0]).toHaveLength(2);
  });

  it("never runs two flushes at once", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slow = {
      async send() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      },
      async list() { return []; },
    };
    const queue = new EventQueue({ backend: fakeBackendWith(slow), flushMs: 0 });
    queue.record({ campaignId: "c", deviceId: "d", kind: "proof-of-play" });
    await Promise.all([queue.flush(), queue.flush(), queue.flush()]);
    expect(maxConcurrent).toBe(1);
  });

  it("stops its timer cleanly", () => {
    const { sink } = memorySink();
    const queue = new EventQueue({ backend: fakeBackendWith(sink), flushMs: 50 });
    queue.stop();
    expect(queue.size).toBe(0);
  });
});
