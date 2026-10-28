/**
 * Server-side session store for the BFF.
 *
 * A session maps an opaque cookie token (only its SHA-256 is stored) to the
 * upstream Supabase credentials plus the account snapshot the browser is
 * allowed to see. Because the mapping lives on the server, the browser never
 * holds a bearer token: `HttpOnly` really does hide the credential, and
 * `revoke()` really does end the session.
 *
 * Three stores ship here:
 *
 *   memory    development and tests only; vanishes on restart
 *   file      one host, durable, no extra dependency (0640 JSON, atomic rename)
 *   postgres  multi-instance; `bff_sessions` has RLS on and no policies
 *
 * Upstream tokens are encrypted with AES-256-GCM when `BFF_SESSION_KEY` is set
 * (required in production). Without it the store still works, but a database
 * dump would contain usable bearer tokens — `describeConfigGaps` reports that.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Queryable } from "../db/types";

export interface SessionRecord {
  /** sha256(session token) — never the token itself. */
  id: string;
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  accessExpiresAt: number;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  /**
   * Account snapshot the browser is allowed to see. Cached here so the session
   * endpoint is a single indexed read instead of an upstream round trip on
   * every poll; refreshed whenever the session is rotated.
   */
  account: SessionAccount;
}

/** The subset of `TerminalAccount` the BFF persists (and returns). */
export interface SessionAccount {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  pairCode: string;
  frontPairCode?: string;
  createdAt: string;
  source: "bff";
}

export interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  /** Persist a refreshed token set and/or a new last-seen time. */
  update(record: SessionRecord): Promise<void>;
  revoke(id: string): Promise<void>;
  /** Used by the credential-rotation tooling and "sign out everywhere". */
  revokeUser(userId: string): Promise<number>;
  purgeExpired(now: number): Promise<number>;
}

/* ------------------------------------------------------------------ *
 * Encryption at rest
 * ------------------------------------------------------------------ */

const SEAL_PREFIX = "v1";
const PLAIN_PREFIX = "plain";

export function sealTokens(accessToken: string, refreshToken: string, key?: Buffer): string {
  const payload = JSON.stringify({ a: accessToken, r: refreshToken });
  if (!key) return `${PLAIN_PREFIX}.${Buffer.from(payload, "utf8").toString("base64url")}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SEAL_PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function openTokens(sealed: string, key?: Buffer): { accessToken: string; refreshToken: string } {
  const [prefix, ...rest] = sealed.split(".");
  if (prefix === PLAIN_PREFIX) {
    const parsed = JSON.parse(Buffer.from(rest.join("."), "base64url").toString("utf8")) as { a: string; r: string };
    return { accessToken: parsed.a, refreshToken: parsed.r };
  }
  if (prefix !== SEAL_PREFIX) throw new Error("session: unknown sealed payload format");
  if (!key) throw new Error("session: BFF_SESSION_KEY is required to open an encrypted session");
  const [ivPart, tagPart, cipherPart] = rest;
  if (!ivPart || !tagPart || !cipherPart) throw new Error("session: malformed sealed payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(cipherPart, "base64url")), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString("utf8")) as { a: string; r: string };
  return { accessToken: parsed.a, refreshToken: parsed.r };
}

/* ------------------------------------------------------------------ *
 * memory
 * ------------------------------------------------------------------ */

export function createMemorySessionStore(clock: () => number = Date.now): SessionStore {
  const rows = new Map<string, SessionRecord>();
  const copy = (record: SessionRecord): SessionRecord => ({ ...record });

  return {
    async create(record) {
      rows.set(record.id, copy(record));
    },
    async get(id) {
      const row = rows.get(id);
      if (!row) return null;
      if (row.absoluteExpiresAt <= clock()) {
        rows.delete(id);
        return null;
      }
      return copy(row);
    },
    async update(record) {
      if (rows.has(record.id)) rows.set(record.id, copy(record));
    },
    async revoke(id) {
      rows.delete(id);
    },
    async revokeUser(userId) {
      let removed = 0;
      for (const [id, row] of rows) {
        if (row.userId === userId) {
          rows.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    async purgeExpired(now) {
      let removed = 0;
      for (const [id, row] of rows) {
        if (row.absoluteExpiresAt <= now) {
          rows.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

/* ------------------------------------------------------------------ *
 * file — single host, durable, dependency free
 * ------------------------------------------------------------------ */

interface PersistedRow {
  id: string;
  userId: string;
  email: string;
  sealed: string;
  accessExpiresAt: number;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  account: SessionAccount;
}

export function createFileSessionStore(options: {
  file: string;
  key?: Buffer;
  clock?: () => number;
  /** Fail instead of silently starting empty when the file is corrupt. */
  onCorrupt?: (error: unknown) => void;
}): SessionStore {
  const clock = options.clock ?? Date.now;
  let loaded: Promise<Map<string, PersistedRow>> | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  async function load(): Promise<Map<string, PersistedRow>> {
    if (!loaded) {
      loaded = (async () => {
        try {
          const raw = await readFile(options.file, "utf8");
          const parsed = JSON.parse(raw) as PersistedRow[];
          if (!Array.isArray(parsed)) throw new Error("session file is not an array");
          return new Map(parsed.map((row) => [row.id, row]));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return new Map();
          options.onCorrupt?.(error);
          throw error;
        }
      })();
    }
    return loaded;
  }

  function persist(rows: Map<string, PersistedRow>): Promise<void> {
    const snapshot = JSON.stringify([...rows.values()]);
    writeChain = writeChain.then(async () => {
      await mkdir(path.dirname(options.file), { recursive: true });
      const temporary = `${options.file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, options.file);
    });
    return writeChain;
  }

  function toRecord(row: PersistedRow): SessionRecord {
    const { accessToken, refreshToken } = openTokens(row.sealed, options.key);
    return { ...row, accessToken, refreshToken };
  }

  function toRow(record: SessionRecord): PersistedRow {
    return {
      id: record.id,
      userId: record.userId,
      email: record.email,
      sealed: sealTokens(record.accessToken, record.refreshToken, options.key),
      accessExpiresAt: record.accessExpiresAt,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      absoluteExpiresAt: record.absoluteExpiresAt,
      account: record.account,
    };
  }

  return {
    async create(record) {
      const rows = await load();
      rows.set(record.id, toRow(record));
      await persist(rows);
    },
    async get(id) {
      const rows = await load();
      const row = rows.get(id);
      if (!row) return null;
      if (row.absoluteExpiresAt <= clock()) {
        rows.delete(id);
        await persist(rows);
        return null;
      }
      return toRecord(row);
    },
    async update(record) {
      const rows = await load();
      if (!rows.has(record.id)) return;
      rows.set(record.id, toRow(record));
      await persist(rows);
    },
    async revoke(id) {
      const rows = await load();
      if (rows.delete(id)) await persist(rows);
    },
    async revokeUser(userId) {
      const rows = await load();
      let removed = 0;
      for (const [id, row] of rows) {
        if (row.userId === userId) {
          rows.delete(id);
          removed += 1;
        }
      }
      if (removed > 0) await persist(rows);
      return removed;
    },
    async purgeExpired(now) {
      const rows = await load();
      let removed = 0;
      for (const [id, row] of rows) {
        if (row.absoluteExpiresAt <= now) {
          rows.delete(id);
          removed += 1;
        }
      }
      if (removed > 0) await persist(rows);
      return removed;
    },
  };
}

/* ------------------------------------------------------------------ *
 * postgres — multi-instance deployments
 * ------------------------------------------------------------------ */

// The table is created by supabase/migrations/0007_bff_sessions.sql — schema
// lives with the other migrations, not in application code. `main.ts` checks it
// exists at boot and fails with a pointer to that migration instead of
// surfacing a confusing "relation does not exist" on the first login.

interface SessionDbRow {
  id: string;
  user_id: string;
  email: string;
  sealed: string;
  access_expires_at: string | number;
  created_at: string | number;
  last_seen_at: string | number;
  absolute_expires_at: string | number;
  account: SessionAccount | string | null;
}

export function createPostgresSessionStore(queryable: Queryable, options: { key?: Buffer; clock?: () => number } = {}): SessionStore {
  const clock = options.clock ?? Date.now;

  function fromRow(row: SessionDbRow): SessionRecord {
    const { accessToken, refreshToken } = openTokens(row.sealed, options.key);
    return {
      id: row.id,
      userId: row.user_id,
      email: row.email,
      accessToken,
      refreshToken,
      accessExpiresAt: Number(row.access_expires_at),
      createdAt: Number(row.created_at),
      lastSeenAt: Number(row.last_seen_at),
      absoluteExpiresAt: Number(row.absolute_expires_at),
      account:
        typeof row.account === "string"
          ? (JSON.parse(row.account) as SessionAccount)
          : (row.account ?? { id: row.user_id, name: "", email: row.email, phone: "", city: "", pairCode: "", createdAt: new Date(0).toISOString(), source: "bff" }),
    };
  }

  return {
    async create(record) {
      await queryable.query(
        `insert into public.bff_sessions
           (id, user_id, email, sealed, access_expires_at, created_at, last_seen_at, absolute_expires_at, account)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          record.id,
          record.userId,
          record.email,
          sealTokens(record.accessToken, record.refreshToken, options.key),
          record.accessExpiresAt,
          record.createdAt,
          record.lastSeenAt,
          record.absoluteExpiresAt,
          JSON.stringify(record.account),
        ],
      );
    },
    async get(id) {
      const result = await queryable.query<SessionDbRow>(
        `select id, user_id, email, sealed, access_expires_at, created_at, last_seen_at, absolute_expires_at, account
           from public.bff_sessions where id = $1 and absolute_expires_at > $2`,
        [id, clock()],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },
    async update(record) {
      await queryable.query(
        `update public.bff_sessions
            set sealed = $2, access_expires_at = $3, last_seen_at = $4, absolute_expires_at = $5, account = $6
          where id = $1`,
        [
          record.id,
          sealTokens(record.accessToken, record.refreshToken, options.key),
          record.accessExpiresAt,
          record.lastSeenAt,
          record.absoluteExpiresAt,
          JSON.stringify(record.account),
        ],
      );
    },
    async revoke(id) {
      await queryable.query("delete from public.bff_sessions where id = $1", [id]);
    },
    async revokeUser(userId) {
      const result = await queryable.query("delete from public.bff_sessions where user_id = $1", [userId]);
      return result.rowCount ?? 0;
    },
    async purgeExpired(now) {
      const result = await queryable.query("delete from public.bff_sessions where absolute_expires_at <= $1", [now]);
      return result.rowCount ?? 0;
    },
  };
}

/** Session lifetime helpers, kept together so the rules are auditable. */
export function sessionIsExpired(record: SessionRecord, now: number, idleSeconds: number): boolean {
  if (record.absoluteExpiresAt <= now) return true;
  return now - record.lastSeenAt > idleSeconds * 1000;
}
