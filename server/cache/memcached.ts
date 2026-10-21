/**
 * Memcached — read-through cache for the read-heavy paths.
 *
 * The "too many reads" problem is not solved by replicas alone: the same
 * campaign lists, terminal directories and asset metadata are re-read from
 * Postgres on every display poll. Memcached sits in front of the replicas and
 * absorbs the repeats:
 *
 *   read  ──▶ memcached hit? ──▶ done (no database involved)
 *              │ miss
 *              ▼
 *           read replica (or primary) ──▶ populate cache with TTL
 *
 *   write ──▶ primary (through PgBouncer) ──▶ invalidate cache keys
 *
 * This module has two halves:
 *
 * 1. A minimal **memcached text-protocol client** (get/set/add/replace/
 *    delete/touch/incr/version) over an injected socket. No npm dependency,
 *    so it works in constrained deploys and tests alike. Requests may be
 *    pipelined; responses are matched in order (memcached guarantees that).
 * 2. A **read-through cache** with JSON codec, TTLs, write-through set,
 *    invalidation, and single-flight dedupe so a cold key under load triggers
 *    one database load, not one per request (cache stampede protection).
 */

/* ------------------------------------------------------------------ *
 * Socket abstraction
 * ------------------------------------------------------------------ */

export interface MemcachedSocket {
  write(chunk: string): void;
  onData(handler: (chunk: string) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export type SocketFactory = (host: string, port: number) => Promise<MemcachedSocket>;

/* ------------------------------------------------------------------ *
 * Text-protocol client
 * ------------------------------------------------------------------ */

export interface MemcachedClientOptions {
  /** `host:port` entries; keys are spread across them by FNV-1a hash. */
  servers: string[];
  socketFactory: SocketFactory;
  /** Default TTL for `set` when the caller does not pass one (seconds). */
  defaultTtlSeconds?: number;
}

export interface MemcachedClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  add(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  replace(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  touch(key: string, ttlSeconds: number): Promise<boolean>;
  incr(key: string, by?: number): Promise<number | null>;
  version(): Promise<string>;
  close(): Promise<void>;
  readonly servers: string[];
}

class ProtocolError extends Error {}

interface Pending {
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
  /** How many raw reply lines this command consumes before the next command. */
  kind: "retrieval" | "storage" | "delete" | "touch" | "numeric" | "text";
}

function parseServer(entry: string): { host: string; port: number } {
  const trimmed = entry.trim();
  const match = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$/.exec(trimmed);
  if (!match) throw new ProtocolError(`bad memcached server address: ${entry}`);
  const host = match[1].replace(/^\[|\]$/g, "");
  return { host, port: match[2] ? Number(match[2]) : 11211 };
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function encodeStorage(command: "set" | "add" | "replace", key: string, value: string, ttl: number): string {
  return `${command} ${key} 0 ${Math.max(0, Math.trunc(ttl))} ${Buffer.byteLength(value, "utf8")}\r\n${value}\r\n`;
}

/** The state machine that turns reply chunks into per-command results. */
class ReplyParser {
  private buffer = "";
  private dataLeft = 0;
  private collected: string[] = [];

  feed(chunk: string): Array<{ done: boolean; lines: string[] }> {
    this.buffer += chunk;
    const finished: Array<{ done: boolean; lines: string[] }> = [];
    for (;;) {
      if (this.dataLeft > 0) {
        // Value payloads are `<bytes>` followed by a framing CRLF — consume
        // both together (we padded dataLeft by 2) and store just the payload,
        // so the framing never shows up as a phantom empty reply line.
        if (this.buffer.length < this.dataLeft) return finished;
        const raw = this.buffer.slice(0, this.dataLeft);
        this.buffer = this.buffer.slice(this.dataLeft);
        this.dataLeft = 0;
        this.collected.push(raw.slice(0, -2));
        continue;
      }
      const crlf = this.buffer.indexOf("\r\n");
      if (crlf === -1) return finished;
      const line = this.buffer.slice(0, crlf);
      this.buffer = this.buffer.slice(crlf + 2);
      if (line.startsWith("VALUE ")) {
        // VALUE <key> <flags> <bytes> — payload + framing CRLF comes next.
        const parts = line.split(" ");
        this.dataLeft = Number(parts[3]) + 2;
        this.collected.push(line);
        continue;
      }
      if (line === "END" || line === "STORED" || line === "NOT_STORED" || line === "EXISTS" ||
          line === "NOT_FOUND" || line === "DELETED" || line === "TOUCHED" || line === "ERROR" ||
          line.startsWith("CLIENT_ERROR") || line.startsWith("SERVER_ERROR") ||
          /^\d+$/.test(line) || line.startsWith("VERSION ")) {
        this.collected.push(line);
        finished.push({ done: true, lines: this.collected });
        this.collected = [];
        continue;
      }
      // Unrecognised trailing line — keep it with the current reply.
      this.collected.push(line);
    }
  }
}

export function createMemcachedClient(options: MemcachedClientOptions): MemcachedClient {
  const servers = options.servers.map((entry) => {
    const parsed = parseServer(entry);
    return `${parsed.host}:${parsed.port}`;
  });
  if (servers.length === 0) throw new ProtocolError("memcached needs at least one server");

  const defaultTtl = options.defaultTtlSeconds ?? 60;
  type Session = {
    socket: MemcachedSocket;
    parser: ReplyParser;
    queue: Pending[];
    broken: boolean;
  };
  // One connection per server, promise-memoised: concurrent first requests
  // must not race past the factory and open duplicate sockets.
  const sessions = new Map<string, Promise<Session>>();

  async function sessionFor(key: string): Promise<Session> {
    const address = servers[fnv1a32(key) % servers.length];
    for (;;) {
      let creation = sessions.get(address);
      if (!creation) {
        creation = (async (): Promise<Session> => {
          const [host, port] = [address.split(":")[0], Number(address.split(":")[1])];
          const socket = await options.socketFactory(host, port);
          const session: Session = { socket, parser: new ReplyParser(), queue: [], broken: false };
          socket.onData((chunk) => {
            for (const result of session.parser.feed(chunk)) {
              const pending = session.queue.shift();
              if (pending) pending.resolve(result.lines);
            }
          });
          socket.onError((error) => {
            session.broken = true;
            while (session.queue.length) session.queue.shift()?.reject(error);
          });
          socket.onClose(() => {
            session.broken = true;
            while (session.queue.length) session.queue.shift()?.reject(new ProtocolError("memcached connection closed"));
          });
          return session;
        })();
        sessions.set(address, creation);
      }
      // NOTE: every caller awaits the same way (`await creation` then return).
      // An earlier `return creation` for the creating call took extra
      // microtask hops and reordered pipelined writes relative to their
      // queue entries — replies then matched the wrong pending command.
      const session = await creation;
      if (!session.broken) return session;
      if (sessions.get(address) === creation) sessions.delete(address);
    }
  }

  function send(key: string, payload: string, kind: Pending["kind"]): Promise<string[]> {
    return sessionFor(key).then((session) => {
      return new Promise<string[]>((resolve, reject) => {
        session.queue.push({ resolve, reject, kind });
        try {
          session.socket.write(payload);
        } catch (error) {
          session.queue.pop();
          reject(error instanceof Error ? error : new ProtocolError(String(error)));
        }
      });
    });
  }

  async function storage(command: "set" | "add" | "replace", key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    const lines = await send(key, encodeStorage(command, key, value, ttlSeconds ?? defaultTtl), "storage");
    const reply = lines[lines.length - 1];
    if (reply === "STORED") return true;
    if (reply === "NOT_STORED" || reply === "EXISTS" || reply === "NOT_FOUND") return false;
    throw new ProtocolError(reply ?? "empty memcached reply");
  }

  return {
    servers,
    async get(key) {
      const lines = await send(key, `get ${key}\r\n`, "retrieval");
      // VALUE lines are ["VALUE k flags bytes", <data>, "END"] — or just ["END"].
      const end = lines.lastIndexOf("END");
      if (end <= 0) return null;
      return lines[end - 1] ?? null;
    },
    set: (key, value, ttl) => storage("set", key, value, ttl),
    add: (key, value, ttl) => storage("add", key, value, ttl),
    replace: (key, value, ttl) => storage("replace", key, value, ttl),
    async delete(key) {
      const lines = await send(key, `delete ${key}\r\n`, "delete");
      return lines[0] === "DELETED";
    },
    async touch(key, ttlSeconds) {
      const lines = await send(key, `touch ${key} ${Math.max(0, Math.trunc(ttlSeconds))}\r\n`, "touch");
      return lines[0] === "TOUCHED";
    },
    async incr(key, by = 1) {
      const lines = await send(key, `incr ${key} ${Math.max(0, Math.trunc(by))}\r\n`, "numeric");
      const reply = lines[0];
      if (reply && /^\d+$/.test(reply)) return Number(reply);
      return null;
    },
    async version() {
      // Any key routes to some server; version is connection-level.
      const lines = await send(servers[0], "version\r\n", "text");
      return lines[0].replace(/^VERSION\s*/, "");
    },
    async close() {
      for (const pending of sessions.values()) {
        const session = await pending.catch(() => null);
        if (session) {
          session.broken = true;
          session.socket.close();
        }
      }
      sessions.clear();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Read-through cache
 * ------------------------------------------------------------------ */

export interface ReadThroughCacheStats {
  hits: number;
  misses: number;
  loads: number;
  errors: number;
  invalidations: number;
}

export interface ReadThroughCache {
  /** Cache-aside read with single-flight loader. */
  getOrLoad<T>(key: string, loader: () => Promise<T>, ttlSeconds?: number): Promise<{ value: T; hit: boolean }>;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  /**
   * Atomically increment a counter (memcached `incr`, seeded on first use).
   * Used for generation-stamped keys: a write bumps `campaigns:list:gen` and
   * every list variant re-keys itself, since memcached cannot delete by prefix.
   */
  bump(key: string, by?: number): Promise<number>;
  invalidate(...keys: string[]): Promise<void>;
  stats(): ReadThroughCacheStats;
}

export interface ReadThroughCacheOptions {
  /** Null/undefined → passthrough cache (every read is a miss + load). */
  client?: MemcachedClient | null;
  defaultTtlSeconds?: number;
  /** Namespace so different services can share one memcached safely. */
  namespace?: string;
}

interface Codec {
  encode(value: unknown): string;
  decode(raw: string): unknown;
}

const jsonCodec: Codec = {
  encode: (value) => JSON.stringify({ v: 1, d: value }),
  decode: (raw) => {
    const parsed = JSON.parse(raw) as { v?: number; d?: unknown };
    return parsed && typeof parsed === "object" && "d" in parsed ? parsed.d : parsed;
  },
};

export function createReadThroughCache(options: ReadThroughCacheOptions = {}): ReadThroughCache {
  const client = options.client ?? null;
  const ttl = options.defaultTtlSeconds ?? 60;
  const namespace = options.namespace ?? "rf";
  const stats: ReadThroughCacheStats = { hits: 0, misses: 0, loads: 0, errors: 0, invalidations: 0 };
  const inFlight = new Map<string, Promise<unknown>>();

  const namespaced = (key: string) => `${namespace}:${key}`;

  return {
    async getOrLoad<T>(key: string, loader: () => Promise<T>, ttlSeconds = ttl): Promise<{ value: T; hit: boolean }> {
      const cached = await this.get<T>(key);
      if (cached !== undefined) {
        stats.hits += 1;
        return { value: cached, hit: true };
      }
      stats.misses += 1;

      // Single-flight: concurrent misses on one key share one loader.
      const existing = inFlight.get(key);
      if (existing) {
        return { value: (await existing) as T, hit: false };
      }
      const load = (async () => {
        stats.loads += 1;
        const value = await loader();
        await this.set(key, value, ttlSeconds);
        return value;
      })();
      inFlight.set(key, load);
      try {
        return { value: (await load) as T, hit: false };
      } finally {
        inFlight.delete(key);
      }
    },

    async get<T>(key: string): Promise<T | undefined> {
      if (!client) return undefined;
      try {
        const raw = await client.get(namespaced(key));
        if (raw === null) return undefined;
        return jsonCodec.decode(raw) as T;
      } catch {
        stats.errors += 1;
        return undefined;
      }
    },

    async set<T>(key: string, value: T, ttlSeconds = ttl): Promise<void> {
      if (!client) return;
      try {
        await client.set(namespaced(key), jsonCodec.encode(value), ttlSeconds);
      } catch {
        stats.errors += 1;
      }
    },

    async bump(key: string, by = 1): Promise<number> {
      if (!client) return by;
      const fullKey = namespaced(key);
      try {
        const bumped = await client.incr(fullKey, by);
        if (bumped !== null) return bumped;
        // First use: seed the counter. `add` is atomic — if we lose the race,
        // the winner's value is there and a retry of `incr` picks it up.
        const seeded = await client.add(fullKey, String(by), 0);
        if (seeded) return by;
        return (await client.incr(fullKey, by)) ?? by;
      } catch {
        stats.errors += 1;
        return by;
      }
    },

    async invalidate(...keys: string[]): Promise<void> {
      if (!client || keys.length === 0) return;
      stats.invalidations += keys.length;
      await Promise.all(
        keys.map(async (key) => {
          try {
            await client.delete(namespaced(key));
          } catch {
            stats.errors += 1;
          }
        }),
      );
    },

    stats: () => ({ ...stats }),
  };
}

/* ------------------------------------------------------------------ *
 * In-memory client — tests and single-node dev, same interface.
 * ------------------------------------------------------------------ */

export function createMemoryMemcached(): MemcachedClient & { flush(): void; size(): number } {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const now = () => Date.now();
  const alive = (entry: { expiresAt: number }) => entry.expiresAt === 0 || entry.expiresAt > now();
  const server = "memory:11211";

  return {
    servers: [server],
    async get(key) {
      const entry = store.get(key);
      if (!entry || !alive(entry)) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds = 0) {
      store.set(key, { value, expiresAt: ttlSeconds > 0 ? now() + ttlSeconds * 1000 : 0 });
      return true;
    },
    async add(key, value, ttlSeconds = 0) {
      const entry = store.get(key);
      if (entry && alive(entry)) return false;
      return this.set(key, value, ttlSeconds);
    },
    async replace(key, value, ttlSeconds = 0) {
      const entry = store.get(key);
      if (!entry || !alive(entry)) return false;
      return this.set(key, value, ttlSeconds);
    },
    async delete(key) {
      return store.delete(key);
    },
    async touch(key, ttlSeconds) {
      const entry = store.get(key);
      if (!entry || !alive(entry)) return false;
      entry.expiresAt = ttlSeconds > 0 ? now() + ttlSeconds * 1000 : 0;
      return true;
    },
    async incr(key, by = 1) {
      const entry = store.get(key);
      if (!entry || !alive(entry)) return null;
      const next = Number(entry.value) + by;
      if (!Number.isFinite(next)) return null;
      entry.value = String(next);
      return next;
    },
    async version() {
      return "memory";
    },
    async close() {
      store.clear();
    },
    flush() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}
