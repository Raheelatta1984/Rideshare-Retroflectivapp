/**
 * next_id — clash-proof, sortable 64-bit identifiers in three parts:
 *
 *   ┌────────────── 41 bits ──────────────┬── 13 bits ──┬── 10 bits ──┐
 *   │  ms since 2026-01-01T00:00:00Z      │ shard ref   │ counter     │
 *   └─────────────────────────────────────┴─────────────┴─────────────┘
 *     bits 63‥23                           bits 22‥10    bits 9‥0
 *
 * - The timestamp in the high bits makes every id sortable by mint time,
 *   lexicographically as a zero-padded decimal string and numerically as a
 *   bigint (`compareIds`).
 * - The 13-bit shard reference (0‥8191) names the minting machine/generator,
 *   so two generators can never collide even when their clocks agree. The
 *   same shard space is used for image logical shards
 *   (`src/lib/backend/imageShards.ts`) and registered in the `id_shards`
 *   table (supabase/migrations/0004_next_id_image_shards.sql).
 * - The 10-bit counter (0‥1023) serialises ids minted inside the same
 *   millisecond on the same shard. Past 1024 ids in one ms the clock rolls
 *   forward by 1 ms — the id is still monotonic and never blocks.
 *
 * The SQL twin is `public.next_id(shard)` in migration 0004, which locks the
 * shard row so concurrent database writers cannot mint the same value. This
 * module mirrors that algorithm exactly for client-side minting.
 *
 * Signed-bigint note: with the 2026 epoch the sign bit stays clear until
 * 2060, so every id fits both Postgres `bigint` and JS number-range tooling
 * for the next four decades; parse with BigInt regardless.
 */

export const ID_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z

export const TIMESTAMP_BITS = 41;
export const SHARD_BITS = 13;
export const COUNTER_BITS = 10;

export const MAX_SHARD = (1 << SHARD_BITS) - 1; // 8191
export const MAX_COUNTER = (1 << COUNTER_BITS) - 1; // 1023
export const MAX_TIMESTAMP = 2 ** TIMESTAMP_BITS - 1; // ≈ 69.7 years of ms

/** Decimal width of the largest 64-bit id (2^64-1 has 20 digits). */
export const SORTABLE_STRING_WIDTH = 20;

const SHARD_SHIFT = BigInt(COUNTER_BITS); // 10
const TIMESTAMP_SHIFT = BigInt(COUNTER_BITS + SHARD_BITS); // 23
const TIMESTAMP_MASK = BigInt(MAX_TIMESTAMP);
const SHARD_MASK = BigInt(MAX_SHARD);
const COUNTER_MASK = BigInt(MAX_COUNTER);

export interface IdParts {
  /** Milliseconds since the Unix epoch (epoch offset + mint time). */
  timestampMs: number;
  /** 0‥8191 — the shard reference of the minting generator. */
  shard: number;
  /** 0‥1023 — the within-millisecond sequence on that shard. */
  counter: number;
}

export interface IdGenerator {
  /** Mint the next id as a bigint. Monotonic per generator instance. */
  next(): bigint;
  /** Mint the next id as a 20-digit zero-padded decimal string (lex-sortable). */
  nextString(): string;
  /** The shard reference this generator was built with. */
  readonly shard: number;
}

export interface IdGeneratorOptions {
  /** Shard reference 0‥8191. Defaults to a random shard per instance. */
  shard?: number;
  /** Custom epoch for the 41-bit timestamp field. Defaults to ID_EPOCH_MS. */
  epochMs?: number;
  /** Clock override for tests, in Unix milliseconds. */
  clock?: () => number;
}

function assertShard(shard: number): void {
  if (!Number.isInteger(shard) || shard < 0 || shard > MAX_SHARD) {
    throw new RangeError(`next_id shard must be an integer 0‥${MAX_SHARD}, got ${shard}`);
  }
}

/**
 * Build an independent generator. Each instance holds its own (lastMs, counter)
 * state and is monotonic even when the wall clock steps backwards.
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const epochMs = options.epochMs ?? ID_EPOCH_MS;
  const clock = options.clock ?? Date.now;
  const shard = options.shard ?? Math.floor(Math.random() * (MAX_SHARD + 1));
  assertShard(shard);

  let lastMs = Number.NEGATIVE_INFINITY;
  let counter = 0;

  const next = (): bigint => {
    const nowOffset = clock() - epochMs;
    if (nowOffset > MAX_TIMESTAMP) {
      throw new RangeError("next_id: 41-bit timestamp field exhausted (epoch + 69.7 years)");
    }

    if (nowOffset > lastMs) {
      lastMs = nowOffset;
      counter = 0;
    } else {
      // Same millisecond, or the clock stepped backwards / spun faster than
      // 1024 mints per ms. Keep counting inside the current ms…
      counter += 1;
      if (counter > MAX_COUNTER) {
        // …and roll the clock forward when the 10-bit counter is exhausted.
        // Still strictly monotonic, never blocks, never reuses a value.
        lastMs += 1;
        counter = 0;
      }
    }

    return (
      (BigInt(Math.trunc(lastMs)) << TIMESTAMP_SHIFT) |
      (BigInt(shard) << SHARD_SHIFT) |
      BigInt(counter)
    );
  };

  return {
    shard,
    next,
    nextString: () => toSortableString(next()),
  };
}

/** Format an id as a fixed-width decimal string — lexical order = numeric order. */
export function toSortableString(id: bigint): string {
  const value = BigInt(id);
  if (value < 0n) throw new RangeError("next_id values are unsigned 64-bit");
  return value.toString(10).padStart(SORTABLE_STRING_WIDTH, "0");
}

/** Parse a decimal string or bigint back into its three parts. */
export function parseId(id: bigint | string, epochMs: number = ID_EPOCH_MS): IdParts {
  const value = typeof id === "string" ? BigInt(id.trim()) : BigInt(id);
  if (value < 0n || value >> 64n > 0n) {
    throw new RangeError("next_id values must fit in 64 unsigned bits");
  }
  return {
    timestampMs: Number((value >> TIMESTAMP_SHIFT) & TIMESTAMP_MASK) + epochMs,
    shard: Number((value >> SHARD_SHIFT) & SHARD_MASK),
    counter: Number(value & COUNTER_MASK),
  };
}

export function idTimestampMs(id: bigint | string, epochMs: number = ID_EPOCH_MS): number {
  return parseId(id, epochMs).timestampMs;
}

export function idShard(id: bigint | string): number {
  return parseId(id).shard;
}

export function idCounter(id: bigint | string): number {
  return parseId(id).counter;
}

/** Numeric comparison that sorts ids by mint time, then shard, then counter. */
export function compareIds(a: bigint | string, b: bigint | string): number {
  const left = typeof a === "string" ? BigInt(a.trim()) : a;
  const right = typeof b === "string" ? BigInt(b.trim()) : b;
  return left < right ? -1 : left > right ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Process-wide default generator (used by `uid()` in id.ts).
 *
 * The shard is drawn once per generator instance. Register the shard in
 * `public.id_shards` (migration 0004) when minting must be coordinated
 * across machines — the SQL `next_id()` is the arbiter there.
 * ------------------------------------------------------------------ */

let defaultGenerator: IdGenerator | null = null;

export function defaultIdGenerator(): IdGenerator {
  if (!defaultGenerator) defaultGenerator = createIdGenerator();
  return defaultGenerator;
}

export function nextId(): bigint {
  return defaultIdGenerator().next();
}

export function nextIdString(): string {
  return defaultIdGenerator().nextString();
}

/** Test seam — forget the memoised default generator. */
export function resetDefaultIdGenerator(options?: IdGeneratorOptions): void {
  defaultGenerator = options ? createIdGenerator(options) : null;
}
