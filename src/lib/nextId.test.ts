import { describe, expect, it } from "vitest";
import {
  COUNTER_BITS,
  ID_EPOCH_MS,
  MAX_COUNTER,
  MAX_SHARD,
  SHARD_BITS,
  TIMESTAMP_BITS,
  compareIds,
  createIdGenerator,
  idCounter,
  idShard,
  idTimestampMs,
  nextId,
  nextIdString,
  parseId,
  resetDefaultIdGenerator,
  toSortableString,
} from "./nextId";

describe("next_id layout (41-bit time | 13-bit shard | 10-bit counter)", () => {
  it("uses exactly 41 + 13 + 10 = 64 bits", () => {
    expect(TIMESTAMP_BITS + SHARD_BITS + COUNTER_BITS).toBe(64);
    expect(MAX_SHARD).toBe(8191);
    expect(MAX_COUNTER).toBe(1023);
  });

  it("packs and unpacks the three parts", () => {
    let mintedAt = 0;
    const gen = createIdGenerator({ shard: 4242, clock: () => mintedAt });
    mintedAt = ID_EPOCH_MS + 1_000_000;
    const id = gen.next();
    expect(parseId(id)).toEqual({ timestampMs: ID_EPOCH_MS + 1_000_000, shard: 4242, counter: 0 });
    expect(idShard(id)).toBe(4242);
    expect(idCounter(id)).toBe(0);
    expect(idTimestampMs(id)).toBe(ID_EPOCH_MS + 1_000_000);
  });

  it("keeps every part inside its field", () => {
    let now = ID_EPOCH_MS;
    const gen = createIdGenerator({ shard: MAX_SHARD, clock: () => now });
    for (let i = 0; i <= MAX_COUNTER + 5; i += 1) {
      const parts = parseId(gen.next());
      expect(parts.shard).toBe(MAX_SHARD);
      expect(parts.counter).toBeGreaterThanOrEqual(0);
      expect(parts.counter).toBeLessThanOrEqual(MAX_COUNTER);
      now = ID_EPOCH_MS; // same ms the whole way
    }
  });

  it("rejects out-of-range shards", () => {
    expect(() => createIdGenerator({ shard: -1 })).toThrow(/shard/);
    expect(() => createIdGenerator({ shard: MAX_SHARD + 1 })).toThrow(/shard/);
  });
});

describe("sortability", () => {
  it("sorts by mint time across generators and shards", () => {
    const times = [300, 100, 200];
    const ids = times.map((t, i) => {
      let now = ID_EPOCH_MS + t;
      return createIdGenerator({ shard: i * 100, clock: () => now }).next();
    });
    const sorted = [...ids].sort(compareIds);
    expect(sorted.map((id) => parseId(id).timestampMs - ID_EPOCH_MS)).toEqual([100, 200, 300]);
  });

  it("orders by counter within one millisecond on one shard", () => {
    let now = ID_EPOCH_MS + 5;
    const gen = createIdGenerator({ shard: 7, clock: () => now });
    const batch = Array.from({ length: 10 }, () => gen.next());
    const shuffled = [batch[7], batch[0], batch[9], batch[3]];
    expect([...shuffled].sort(compareIds)).toEqual([batch[0], batch[3], batch[7], batch[9]]);
  });

  it("padded decimal strings sort lexicographically like the numbers", () => {
    let now = ID_EPOCH_MS + 1;
    const gen = createIdGenerator({ shard: 1, clock: () => now });
    const a = gen.nextString();
    now = ID_EPOCH_MS + 2;
    const b = gen.nextString();
    now = ID_EPOCH_MS + 2;
    const gen2 = createIdGenerator({ shard: 2, clock: () => now });
    const c = gen2.nextString();
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(a).toMatch(/^\d{20}$/);
  });
});

describe("clash resistance", () => {
  it("never repeats inside a burst of 5000 on one shard", () => {
    let now = ID_EPOCH_MS + 42;
    const gen = createIdGenerator({ shard: 0, clock: () => now });
    const ids = new Set(Array.from({ length: 5000 }, () => gen.next()));
    expect(ids.size).toBe(5000);
  });

  it("rolls the 10-bit counter into the next millisecond past 1024 ids/ms", () => {
    let now = ID_EPOCH_MS + 9;
    const gen = createIdGenerator({ shard: 5, clock: () => now });
    const ids = Array.from({ length: MAX_COUNTER + 2 }, () => gen.next());
    // First 1024 fill the millisecond; the 1025th rolls forward 1 ms.
    expect(parseId(ids[MAX_COUNTER]).counter).toBe(MAX_COUNTER);
    const rolled = parseId(ids[MAX_COUNTER + 1]);
    expect(rolled.counter).toBe(0);
    expect(rolled.timestampMs).toBe(ID_EPOCH_MS + 10);
    expect(compareIds(ids[MAX_COUNTER + 1], ids[MAX_COUNTER])).toBe(1);
  });

  it("stays monotonic when the clock steps backwards", () => {
    let now = ID_EPOCH_MS + 1000;
    const gen = createIdGenerator({ shard: 9, clock: () => now });
    const before = gen.next();
    now = ID_EPOCH_MS + 500; // NTP step backwards
    const after = gen.next();
    expect(compareIds(after, before)).toBe(1);
    expect(parseId(after).timestampMs).toBeGreaterThanOrEqual(ID_EPOCH_MS + 1000);
  });

  it("separates generators on different shards even at the same instant", () => {
    const now = ID_EPOCH_MS + 777;
    const a = createIdGenerator({ shard: 1, clock: () => now }).next();
    const b = createIdGenerator({ shard: 2, clock: () => now }).next();
    expect(a).not.toBe(b);
    expect(idShard(a)).toBe(1);
    expect(idShard(b)).toBe(2);
  });
});

describe("string round-trip", () => {
  it("parses both bigint and decimal string forms", () => {
    let now = ID_EPOCH_MS + 123456;
    const gen = createIdGenerator({ shard: 8191, clock: () => now });
    const id = gen.next();
    expect(parseId(toSortableString(id))).toEqual(parseId(id));
    expect(parseId(id.toString())).toEqual(parseId(id));
  });

  it("rejects values that do not fit 64 bits", () => {
    expect(() => parseId(1n << 64n)).toThrow(/64/);
    expect(() => parseId(-1n)).toThrow(/64/);
  });
});

describe("default generator (used by uid)", () => {
  it("mints unique sortable ids", () => {
    resetDefaultIdGenerator({ shard: 3 });
    const ids = Array.from({ length: 300 }, () => nextId());
    expect(new Set(ids).size).toBe(300);
    expect([...ids].sort(compareIds)).toEqual(ids); // already minted in order
    expect(nextIdString()).toMatch(/^\d{20}$/);
    resetDefaultIdGenerator();
  });
});
