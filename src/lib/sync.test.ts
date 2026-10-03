import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => void;

const mock = vi.hoisted(() => {
  class FakeConnection {
    peer: string;
    open = false;
    handlers: Record<string, Handler[]> = {};
    sent: unknown[] = [];
    constructor(peer: string) {
      this.peer = peer;
    }
    on(event: string, cb: Handler) {
      (this.handlers[event] ||= []).push(cb);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      (this.handlers[event] || []).forEach((cb) => cb(...args));
    }
    send(payload: unknown) {
      this.sent.push(payload);
    }
    close() {}
  }

  class FakePeer {
    id: string;
    options: unknown;
    handlers: Record<string, Handler[]> = {};
    connections: FakeConnection[] = [];
    destroyed = false;
    static instances: FakePeer[] = [];
    constructor(id: string, options?: unknown) {
      this.id = id;
      this.options = options;
      FakePeer.instances.push(this);
    }
    on(event: string, cb: Handler) {
      (this.handlers[event] ||= []).push(cb);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      (this.handlers[event] || []).forEach((cb) => cb(...args));
    }
    connect(target: string) {
      const connection = new FakeConnection(target);
      this.connections.push(connection);
      return connection;
    }
    destroy() {
      this.destroyed = true;
    }
  }

  return { FakePeer, FakeConnection };
});

vi.mock("peerjs", () => ({ default: mock.FakePeer }));

// The hook is imported after the mock declaration above.
const { usePairChannel } = await import("./sync");

class FakeBroadcastChannel {
  name: string;
  handlers: Record<string, Handler[]> = {};
  constructor(name: string) {
    this.name = name;
  }
  addEventListener(event: string, cb: Handler) {
    (this.handlers[event] ||= []).push(cb);
  }
  removeEventListener(event: string, cb: Handler) {
    this.handlers[event] = (this.handlers[event] || []).filter((item) => item !== cb);
  }
  postMessage() {}
  close() {}
}

const originalBroadcastChannel = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

beforeEach(() => {
  mock.FakePeer.instances.length = 0;
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = originalBroadcastChannel;
});

function lastPeer() {
  const peer = mock.FakePeer.instances.at(-1);
  if (!peer) throw new Error("no peer was created");
  return peer;
}

describe("usePairChannel identity", () => {
  // Regression: peer ids were built from a mangled template literal, so every
  // peer registered as the same literal string and the pair code was never
  // part of the id. The target side was built as a wildcard that PeerJS cannot
  // resolve, and it was never actually used to dial anything.
  it("claims a deterministic host id", () => {
    renderHook(() => usePairChannel("7K2M9Q", "host"));
    expect(lastPeer().id).toBe("retroflex-7K2M9Q-host");
  });

  it("claims a deterministic display id", () => {
    renderHook(() => usePairChannel("7K2M9Q", "display"));
    expect(lastPeer().id).toBe("retroflex-7K2M9Q-display");
  });

  it("keeps two pair codes on the same phone apart", () => {
    renderHook(() => usePairChannel("AAAAAA", "host"));
    renderHook(() => usePairChannel("BBBBBB", "host"));
    const ids = mock.FakePeer.instances.map((peer) => peer.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("usePairChannel connection", () => {
  it("dials the tablet as soon as the host peer opens", () => {
    renderHook(() => usePairChannel("7K2M9Q", "host"));
    const peer = lastPeer();

    expect(peer.connections).toHaveLength(0);
    act(() => peer.emit("open", peer.id));

    expect(peer.connections).toHaveLength(1);
    expect(peer.connections[0].peer).toBe("retroflex-7K2M9Q-display");
  });

  it("dials the phone back when the display opens first", () => {
    renderHook(() => usePairChannel("7K2M9Q", "display"));
    const peer = lastPeer();
    act(() => peer.emit("open", peer.id));
    expect(peer.connections[0].peer).toBe("retroflex-7K2M9Q-host");
  });

  it("accepts incoming connections and reports traffic", () => {
    const seen: unknown[] = [];
    const { result } = renderHook(() =>
      usePairChannel("7K2M9Q", "display", (packet) => seen.push(packet)),
    );
    const peer = lastPeer();

    const real = new mock.FakeConnection("retroflex-7K2M9Q-host");
    (peer.handlers["connection"] || []).forEach((cb) => cb(real));
    act(() => real.emit("open"));
    act(() => real.emit("data", { type: "ride", packetId: "pkt_1_abc" }));

    expect(seen).toHaveLength(1);
    expect(real.sent[0]).toMatchObject({ type: "ack", acknowledges: "pkt_1_abc" });
    expect(result.current.connected).toBe(true);
  });

  it("survives a peer-unavailable error without tearing the peer down", () => {
    renderHook(() => usePairChannel("7K2M9Q", "host"));
    const peer = lastPeer();
    act(() => peer.emit("open", peer.id));
    const created = mock.FakePeer.instances.length;

    act(() => peer.emit("error", { type: "peer-unavailable", message: "Could not connect to peer" }));

    // No reconnect storm: the same peer is kept and simply dialled again later.
    expect(mock.FakePeer.instances.length).toBe(created);
    expect(peer.destroyed).toBe(false);
  });

  it("takes a suffixed id when the deterministic id is already claimed", async () => {
    renderHook(() => usePairChannel("7K2M9Q", "host"));
    const peer = lastPeer();
    act(() => peer.emit("error", { type: "unavailable-id", message: "ID is taken" }));

    await new Promise((resolve) => setTimeout(resolve, 700));

    const ids = mock.FakePeer.instances.map((item) => item.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(ids[1].startsWith("retroflex-7K2M9Q-host-")).toBe(true);
  });
});

describe("usePairChannel transport config", () => {
  it("signals over the public PeerJS cloud when no relay is configured", () => {
    renderHook(() => usePairChannel("7K2M9Q", "host"));
    const options = lastPeer().options as { host: string; port: number; secure: boolean };
    expect(options.host).toBe("0.peerjs.com");
    expect(options.port).toBe(443);
    expect(options.secure).toBe(true);
  });

  // Regression: the app used to poll a relay host that does not resolve
  // (relay.retroflex.app) every three seconds from every open tab.
  it("never talks to a relay that is not configured", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderHook(() => usePairChannel("7K2M9Q", "host"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no longer ships a hard-coded TURN credential", () => {
    renderHook(() => usePairChannel("7K2M9Q", "host"));
    const options = lastPeer().options as { config: { iceServers: Array<{ credential?: string }> } };
    expect(JSON.stringify(options.config)).not.toContain("beacon2024");
  });
});
