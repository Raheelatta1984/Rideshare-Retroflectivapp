import { describe, expect, it } from "vitest";
import type { MemcachedSocket } from "./memcached";
import { createMemcachedClient, createMemoryMemcached, createReadThroughCache } from "./memcached";

/* ------------------------------------------------------------------ *
 * Fake server socket — records what the client writes and lets the
 * test script replies back through onData, exactly like the wire.
 * ------------------------------------------------------------------ */

class FakeSocket implements MemcachedSocket {
  written: string[] = [];
  private dataHandler: ((chunk: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  write(chunk: string): void {
    this.written.push(chunk);
  }
  onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler;
  }
  onError(): void {
    /* not needed in these tests */
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closeHandler?.();
  }
  /** Simulate a server reply (or several pipelined ones). */
  reply(chunk: string): void {
    this.dataHandler?.(chunk);
  }
}

function harness(servers: string[] = ["cache-a:11211"]) {
  const sockets: FakeSocket[] = [];
  const client = createMemcachedClient({
    servers,
    socketFactory: async () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets };
}

/** Commands write through async session setup — flush microtasks + the socket factory. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("memcached text protocol", () => {
  it("encodes set with byte-count framing and parses STORED", async () => {
    const { client, sockets } = harness();
    const pending = client.set("k1", "héllo", 30);
    await flush();
    const socket = sockets[0];
    expect(socket.written[0]).toBe("set k1 0 30 6\r\nhéllo\r\n"); // 6 UTF-8 bytes
    socket.reply("STORED\r\n");
    await expect(pending).resolves.toBe(true);
  });

  it("returns the value on a get hit and null on a miss", async () => {
    const { client, sockets } = harness();
    const hit = client.get("k1");
    await flush();
    sockets[0].reply("VALUE k1 0 5\r\nhello\r\nEND\r\n");
    await expect(hit).resolves.toBe("hello");

    const miss = client.get("k2");
    await flush();
    sockets[0].reply("END\r\n");
    await expect(miss).resolves.toBe(null);
  });

  it("handles empty values without confusing the parser", async () => {
    const { client, sockets } = harness();
    const pending = client.get("empty");
    await flush();
    sockets[0].reply("VALUE empty 0 0\r\n\r\nEND\r\n");
    await expect(pending).resolves.toBe("");
  });

  it("pipelines requests and matches replies in order", async () => {
    const { client, sockets } = harness();
    const first = client.get("a");
    const second = client.delete("a");
    const third = client.version();
    await flush();
    const socket = sockets[0];
    expect(socket.written).toEqual(["get a\r\n", "delete a\r\n", "version\r\n"]);
    socket.reply("VALUE a 0 1\r\nx\r\nEND\r\nDELETED\r\nVERSION 1.6.22\r\n");
    await expect(first).resolves.toBe("x");
    await expect(second).resolves.toBe(true);
    await expect(third).resolves.toBe("1.6.22");
  });

  it("reports storage rejection honestly (add on a live key)", async () => {
    const { client, sockets } = harness();
    const pending = client.add("k", "v");
    await flush();
    sockets[0].reply("NOT_STORED\r\n");
    await expect(pending).resolves.toBe(false);
  });

  it("surfaces server errors as rejections", async () => {
    const { client, sockets } = harness();
    const pending = client.set("k", "v");
    await flush();
    sockets[0].reply("SERVER_ERROR out of memory\r\n");
    await expect(pending).rejects.toThrow(/out of memory/);
  });

  it("spreads keys across servers by hash", async () => {
    const { client, sockets } = harness(["cache-a:11211", "cache-b:11211"]);
    const keys = Array.from({ length: 20 }, (_, i) => `key-${i}`);
    const pending = Promise.all(keys.map((key) => client.get(key)));
    await flush();
    expect(sockets.length).toBe(2); // both servers got traffic
    for (const socket of sockets) {
      for (let i = 0; i < socket.written.length; i += 1) socket.reply("END\r\n");
    }
    await pending;
    const total = sockets.reduce((sum, s) => sum + s.written.length, 0);
    expect(total).toBe(20);
  });
});

describe("read-through cache", () => {
  it("loads on miss, serves from cache afterwards", async () => {
    const mem = createMemoryMemcached();
    const cache = createReadThroughCache({ client: mem, namespace: "t" });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return { rows: [1, 2, 3] };
    };

    const first = await cache.getOrLoad("k", loader, 30);
    expect(first).toEqual({ value: { rows: [1, 2, 3] }, hit: false });
    const second = await cache.getOrLoad("k", loader, 30);
    expect(second.hit).toBe(true);
    expect(loads).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, loads: 1 });
  });

  it("collapses concurrent misses into one load (stampede protection)", async () => {
    const mem = createMemoryMemcached();
    const cache = createReadThroughCache({ client: mem });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "value";
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.getOrLoad("hot", loader, 30)),
    );
    expect(results.every((r) => r.value === "value")).toBe(true);
    expect(loads).toBe(1);
  });

  it("bump() versions key spaces atomically", async () => {
    const mem = createMemoryMemcached();
    const cache = createReadThroughCache({ client: mem });
    expect(await cache.bump("gen")).toBe(1);
    expect(await cache.bump("gen")).toBe(2);
    expect(await cache.bump("gen", 5)).toBe(7);
    expect(await cache.get<number>("gen")).toBe(7);
  });

  it("degrades to passthrough when no client is configured", async () => {
    const cache = createReadThroughCache({ client: null });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return 42;
    };
    expect((await cache.getOrLoad("k", loader)).value).toBe(42);
    expect((await cache.getOrLoad("k", loader)).hit).toBe(false);
    expect(loads).toBe(2);
  });

  it("invalidation drops exact keys", async () => {
    const mem = createMemoryMemcached();
    const cache = createReadThroughCache({ client: mem });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.invalidate("a");
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBe(2);
    expect(cache.stats().invalidations).toBe(1);
  });
});

describe("memory memcached", () => {
  it("expires keys by TTL", async () => {
    const mem = createMemoryMemcached();
    await mem.set("k", "v", 0); // no expiry
    expect(await mem.get("k")).toBe("v");
    await mem.touch("k", 0);
    expect(await mem.delete("k")).toBe(true);
    expect(await mem.get("k")).toBe(null);
  });

  it("supports incr semantics", async () => {
    const mem = createMemoryMemcached();
    expect(await mem.incr("n")).toBe(null);
    await mem.set("n", "10");
    expect(await mem.incr("n", 5)).toBe(15);
  });
});
