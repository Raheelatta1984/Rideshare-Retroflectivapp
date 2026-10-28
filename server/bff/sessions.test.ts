// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFileSessionStore,
  createMemorySessionStore,
  createPostgresSessionStore,
  openTokens,
  sealTokens,
  sessionIsExpired,
  type SessionRecord,
} from "./sessions";
import type { QueryResult, Queryable } from "../db/types";

const KEY = Buffer.alloc(32, 3);

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "hash-1",
    userId: "user-1",
    email: "owner@example.com",
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    accessExpiresAt: 1_000,
    createdAt: 0,
    lastSeenAt: 0,
    absoluteExpiresAt: 10_000,
    account: {
      id: "user-1",
      name: "Owner",
      email: "owner@example.com",
      phone: "",
      city: "",
      pairCode: "ABC123",
      createdAt: new Date(0).toISOString(),
      source: "bff",
    },
    ...overrides,
  };
}

describe("token sealing", () => {
  it("round-trips with and without a key", () => {
    expect(openTokens(sealTokens("a", "r", KEY), KEY)).toEqual({ accessToken: "a", refreshToken: "r" });
    expect(openTokens(sealTokens("a", "r"), undefined)).toEqual({ accessToken: "a", refreshToken: "r" });
  });

  it("never stores the token in recoverable plain text when a key is set", () => {
    const sealed = sealTokens("access-token-value", "refresh-token-value", KEY);
    expect(sealed).not.toContain("access-token-value");
    expect(sealed).not.toContain("refresh-token-value");
    expect(sealed.startsWith("v1.")).toBe(true);
  });

  it("refuses to open an encrypted payload without the key", () => {
    const sealed = sealTokens("a", "r", KEY);
    expect(() => openTokens(sealed, undefined)).toThrow(/BFF_SESSION_KEY/);
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = sealTokens("a", "r", KEY);
    const parts = sealed.split(".");
    parts[3] = `${parts[3].slice(0, -2)}AA`;
    expect(() => openTokens(parts.join("."), KEY)).toThrow();
  });
});

describe("memory session store", () => {
  it("supports the full lifecycle", async () => {
    let now = 0;
    const store = createMemorySessionStore(() => now);
    await store.create(record());
    expect((await store.get("hash-1"))?.email).toBe("owner@example.com");

    await store.update({ ...record(), lastSeenAt: 500 });
    expect((await store.get("hash-1"))?.lastSeenAt).toBe(500);

    expect(await store.revokeUser("user-1")).toBe(1);
    expect(await store.get("hash-1")).toBeNull();

    await store.create(record());
    now = 20_000;
    expect(await store.get("hash-1")).toBeNull(); // absolute expiry
    expect(await store.purgeExpired(now)).toBe(0);
  });

  it("computes idle and absolute expiry", () => {
    expect(sessionIsExpired(record(), 3_000, 3)).toBe(false);
    expect(sessionIsExpired(record(), 3_001, 3)).toBe(true);
    expect(sessionIsExpired(record({ absoluteExpiresAt: 10 }), 11, 60)).toBe(true);
  });
});

describe("file session store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rf-bff-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("survives a restart and keeps the file private", async () => {
    const file = path.join(dir, "sessions.json");
    const first = createFileSessionStore({ file, key: KEY, clock: () => 0 });
    await first.create(record());

    const second = createFileSessionStore({ file, key: KEY, clock: () => 0 });
    const loaded = await second.get("hash-1");
    expect(loaded?.accessToken).toBe("access-token-value");

    const mode = (await stat(file)).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group/world access

    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("access-token-value");
  });

  it("refuses to start on a corrupt file instead of silently dropping sessions", async () => {
    const file = path.join(dir, "sessions.json");
    await writeFile(file, "{not json", "utf8");
    const reported: unknown[] = [];
    const store = createFileSessionStore({ file, key: KEY, onCorrupt: (error) => reported.push(error) });
    await expect(store.get("hash-1")).rejects.toThrow();
    expect(reported).toHaveLength(1);
  });
});

describe("postgres session store", () => {
  it("never writes plaintext tokens and binds parameters in order", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const queryable: Queryable = {
      async query<R>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
        queries.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 0 };
      },
    };
    const store = createPostgresSessionStore(queryable, { key: KEY });
    await store.create(record());

    const insert = queries[0];
    expect(insert.sql).toContain("insert into public.bff_sessions");
    expect(insert.params[0]).toBe("hash-1");
    expect(String(insert.params[3])).not.toContain("access-token-value");
    expect(JSON.stringify(insert.params)).not.toContain("access-token-value");
  });

  it("scopes revokeUser by user id", async () => {
    const queries: string[] = [];
    const queryable: Queryable = {
      async query<R>(sql: string): Promise<QueryResult<R>> {
        queries.push(sql);
        return { rows: [], rowCount: 2 };
      },
    };
    const store = createPostgresSessionStore(queryable, { key: KEY });
    expect(await store.revokeUser("user-1")).toBe(2);
    expect(queries[0]).toContain("delete from public.bff_sessions where user_id = $1");
  });
});
