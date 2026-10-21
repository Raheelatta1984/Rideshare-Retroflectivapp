/**
 * Image logical shards + machine map.
 *
 * Image/asset keys are hashed into a fixed logical shard space (13-bit — the
 * same 0‥8191 reference space as `next_id`'s shard field), and a machine map
 * decides which physical machine currently owns each logical shard:
 *
 *   key ──fnv1a32──▶ logical shard (0‥8191) ──machine map──▶ machine + base URL
 *
 * Two-level on purpose:
 *
 * - **Logical shards never move.** `logicalShardFor("cmp_1/hero.png")` is a
 *   pure hash, so an object's shard is stable for life and can be stored once
 *   on the record (or recomputed — both agree).
 * - **The machine map is the only thing that changes when capacity does.**
 *   Rebalancing is an edit to the map (and the `image_shards` table), not a
 *   rehash-and-copy of every object. A lookup always resolves "which machine
 *   holds shard 42 today", including old uploads written before the move.
 *
 * The map is validated so every shard is owned by exactly one machine — gaps
 * and overlaps are configuration bugs and fail loudly at load time.
 */

export const LOGICAL_SHARD_BITS = 13;
export const LOGICAL_SHARD_COUNT = 1 << LOGICAL_SHARD_BITS; // 8192
export const MAX_LOGICAL_SHARD = LOGICAL_SHARD_COUNT - 1;

const utf8 = new TextEncoder();

/**
 * FNV-1a 32-bit over UTF-8 bytes — small, stable, dependency-free, good
 * spread for path keys. Byte-for-byte the same function as `public.fnv1a32`
 * in supabase/migrations/0004_next_id_image_shards.sql, so a key hashes to
 * the same logical shard in the app and in the database.
 */
export function fnv1a32(input: string): number {
  const bytes = utf8.encode(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic logical shard (0‥8191) for an object key. */
export function logicalShardFor(key: string): number {
  return fnv1a32(key) % LOGICAL_SHARD_COUNT;
}

/** Zero-padded logical-shard directory segment, e.g. `shard-0042`. */
export function shardSegment(shard: number): string {
  if (!Number.isInteger(shard) || shard < 0 || shard > MAX_LOGICAL_SHARD) {
    throw new RangeError(`logical shard must be an integer 0‥${MAX_LOGICAL_SHARD}, got ${shard}`);
  }
  return `shard-${String(shard).padStart(4, "0")}`;
}

/* ------------------------------------------------------------------ *
 * Machine map
 * ------------------------------------------------------------------ */

/** One physical machine that stores image bytes. */
export interface ImageMachine {
  /** Stable machine id, referenced by the `image_machines` table. */
  id: string;
  /** Where the machine's object store is reached (no trailing slash). */
  baseUrl: string;
  /**
   * Inclusive logical-shard ranges owned by this machine, e.g. `[[0, 4095]]`.
   * Ranges across all machines must cover 0‥8191 exactly once.
   */
  shardRanges: Array<[number, number]>;
  /** Optional operator note (region, chassis, rack…). */
  note?: string;
}

export interface ImageMachineMap {
  version: number;
  /** Must equal LOGICAL_SHARD_COUNT — checked at validation. */
  shards: number;
  machines: ImageMachine[];
}

export class MachineMapError extends Error {}

function invalid(message: string): never {
  throw new MachineMapError(message);
}

/**
 * Validate a machine map: well-formed machines, in-range inclusive ranges,
 * and every logical shard owned exactly once (no gaps, no overlaps).
 */
export function validateMachineMap(raw: unknown): ImageMachineMap {
  if (typeof raw !== "object" || raw === null) invalid("machine map must be an object");
  const candidate = raw as Partial<ImageMachineMap>;
  if (candidate.shards !== LOGICAL_SHARD_COUNT) {
    invalid(`machine map must declare shards = ${LOGICAL_SHARD_COUNT} (13-bit space)`);
  }
  if (!Array.isArray(candidate.machines) || candidate.machines.length === 0) {
    invalid("machine map needs at least one machine");
  }

  const owners = new Int16Array(LOGICAL_SHARD_COUNT).fill(-1);
  candidate.machines.forEach((machine, index) => {
    if (typeof machine?.id !== "string" || machine.id.length === 0) {
      invalid(`machine at index ${index} needs a non-empty id`);
    }
    if (typeof machine.baseUrl !== "string" || !/^https?:\/\//.test(machine.baseUrl)) {
      invalid(`machine ${machine.id} needs an http(s) baseUrl`);
    }
    if (!Array.isArray(machine.shardRanges) || machine.shardRanges.length === 0) {
      invalid(`machine ${machine.id} needs at least one shard range`);
    }
    for (const range of machine.shardRanges) {
      if (!Array.isArray(range) || range.length !== 2) {
        invalid(`machine ${machine.id} has a malformed shard range`);
      }
      const [start, end] = range;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > MAX_LOGICAL_SHARD || start > end) {
        invalid(`machine ${machine.id} range [${start}, ${end}] is outside 0‥${MAX_LOGICAL_SHARD}`);
      }
      for (let shard = start; shard <= end; shard += 1) {
        if (owners[shard] !== -1) invalid(`logical shard ${shard} is owned by two machines`);
        owners[shard] = index;
      }
    }
  });

  for (let shard = 0; shard < LOGICAL_SHARD_COUNT; shard += 1) {
    if (owners[shard] === -1) invalid(`logical shard ${shard} has no owning machine`);
  }

  return {
    version: candidate.version ?? 1,
    shards: LOGICAL_SHARD_COUNT,
    machines: candidate.machines.map((machine) => ({
      ...machine,
      baseUrl: machine.baseUrl.replace(/\/+$/, ""),
      shardRanges: machine.shardRanges.map(([start, end]) => [start, end] as [number, number]),
    })),
  };
}

/** Which machine owns a logical shard right now. */
export function machineForShard(shard: number, map: ImageMachineMap): ImageMachine {
  for (const machine of map.machines) {
    for (const [start, end] of machine.shardRanges) {
      if (shard >= start && shard <= end) return machine;
    }
  }
  return invalid(`logical shard ${shard} has no owning machine (map is invalid)`);
}

export interface ImagePlacement {
  /** The object's stable logical shard. */
  shard: number;
  /** The machine that currently owns that shard. */
  machine: ImageMachine;
  /** Where the object lives on that machine, relative to `machine.baseUrl`. */
  path: string;
  /** Absolute URL of the object on its owning machine. */
  url: string;
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\\/]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 128) : "object";
}

/**
 * Storage path for an image: `shard-0042/<campaignId>/<filename>`.
 *
 * The shard segment is derived from the full key, so the same campaign folder
 * spreads across shards instead of hot-spotting one directory.
 */
export function imageObjectPath(input: { campaignId: string; filename: string }): string {
  const filename = sanitizeFilename(input.filename);
  const key = `${input.campaignId}/${filename}`;
  return `${shardSegment(logicalShardFor(key))}/${input.campaignId}/${filename}`;
}

/**
 * Resolve an object key through the machine map — shard first, machine second.
 * The returned `path` is relative to `machine.baseUrl` and embeds the shard
 * segment, so moving a shard between machines relocates whole directories.
 */
export function placeImageKey(key: string, map: ImageMachineMap): ImagePlacement {
  const cleanKey = key.replace(/^\/+/, "").replace(/[?#].*$/, "");
  const shard = logicalShardFor(cleanKey);
  const machine = machineForShard(shard, map);
  const objectPath = `${shardSegment(shard)}/${cleanKey}`;
  return {
    shard,
    machine,
    path: objectPath,
    url: `${machine.baseUrl}/${objectPath}`,
  };
}
