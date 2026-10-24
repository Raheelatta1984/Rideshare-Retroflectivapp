/**
 * A small Bloom filter for safe negative membership checks.
 *
 * `mightContain() === false` is definitive only when the filter was seeded
 * from a complete, authoritative inventory and every subsequent insertion is
 * added. A `true` result is always only a hint (false positives are expected).
 * Never use this to authorize access or to filter an incomplete/limited list.
 */

export interface BloomFilterOptions {
  /** Expected item count used to size the bitset. Default: 10,000. */
  expectedItems?: number;
  /** Target false-positive probability. Default: 1%. */
  falsePositiveRate?: number;
}

export interface BloomFilter {
  add(value: string): void;
  mightContain(value: string): boolean;
  readonly size: number;
}

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function createBloomFilter(options: BloomFilterOptions = {}): BloomFilter {
  const expectedItems = Math.max(1, Math.trunc(options.expectedItems ?? 10_000));
  const falsePositiveRate = Math.min(0.25, Math.max(0.000001, options.falsePositiveRate ?? 0.01));
  const bitCount = Math.max(64, Math.ceil((-expectedItems * Math.log(falsePositiveRate)) / (Math.LN2 ** 2)));
  const hashCount = Math.max(1, Math.round((bitCount / expectedItems) * Math.LN2));
  const bits = new Uint8Array(Math.ceil(bitCount / 8));
  let size = 0;

  function positions(value: string): number[] {
    // Double hashing gives k well-distributed positions with two hash passes.
    const first = hash32(value, 0x811c9dc5);
    const second = hash32(value, 0x9e3779b9) | 1;
    return Array.from({ length: hashCount }, (_, i) => (first + Math.imul(i, second)) >>> 0).map((n) => n % bitCount);
  }

  return {
    add(value) {
      for (const position of positions(value)) bits[position >>> 3] |= 1 << (position & 7);
      size += 1;
    },
    mightContain(value) {
      return positions(value).every((position) => (bits[position >>> 3] & (1 << (position & 7))) !== 0);
    },
    get size() {
      return size;
    },
  };
}
