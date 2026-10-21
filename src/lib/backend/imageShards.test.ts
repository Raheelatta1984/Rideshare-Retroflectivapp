import { describe, expect, it } from "vitest";
import {
  LOGICAL_SHARD_COUNT,
  MachineMapError,
  fnv1a32,
  imageObjectPath,
  logicalShardFor,
  machineForShard,
  placeImageKey,
  shardSegment,
  validateMachineMap,
  type ImageMachineMap,
} from "./imageShards";

const map: ImageMachineMap = validateMachineMap({
  version: 1,
  shards: LOGICAL_SHARD_COUNT,
  machines: [
    {
      id: "img-a",
      baseUrl: "https://img-a.retroflex.example/",
      shardRanges: [[0, 4095]],
    },
    {
      id: "img-b",
      baseUrl: "https://img-b.retroflex.example",
      shardRanges: [[4096, 8191]],
    },
  ],
});

describe("logicalShardFor", () => {
  it("is deterministic and inside the 13-bit space", () => {
    for (const key of ["cmp_1/hero.png", "cmp_2/hero.png", "café/ünïcode.gif", "a"]) {
      const shard = logicalShardFor(key);
      expect(shard).toBe(logicalShardFor(key));
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(LOGICAL_SHARD_COUNT);
    }
  });

  it("spreads campaign assets across shards", () => {
    const shards = new Set(
      Array.from({ length: 200 }, (_, i) => logicalShardFor(`cmp_${i}/asset.png`)),
    );
    // 200 keys hashing to only one or two shards would mean a broken hash.
    expect(shards.size).toBeGreaterThan(150);
  });

  it("separates same filename in different campaigns", () => {
    expect(logicalShardFor("cmp_a/hero.png")).not.toBe(logicalShardFor("cmp_b/hero.png"));
  });

  it("fnv1a32 matches the reference vectors", () => {
    // Published FNV-1a 32-bit test vectors.
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("hashes UTF-8 bytes — SQL parity with public.fnv1a32 (migration 0004)", () => {
    // Contract test: a key must map to the same logical shard in the app and
    // in Postgres. The SQL function walks UTF-8 bytes, so this must too.
    const bytes = new TextEncoder().encode("café/ünïcode.gif");
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    expect(fnv1a32("café/ünïcode.gif")).toBe(hash >>> 0);
  });
});

describe("shardSegment", () => {
  it("zero-pads to a sortable directory name", () => {
    expect(shardSegment(0)).toBe("shard-0000");
    expect(shardSegment(42)).toBe("shard-0042");
    expect(shardSegment(8191)).toBe("shard-8191");
  });

  it("rejects out-of-range shards", () => {
    expect(() => shardSegment(-1)).toThrow(/shard/);
    expect(() => shardSegment(LOGICAL_SHARD_COUNT)).toThrow(/shard/);
  });
});

describe("validateMachineMap", () => {
  it("accepts a complete map and strips trailing slashes", () => {
    expect(map.machines[0].baseUrl).toBe("https://img-a.retroflex.example");
    expect(map.shards).toBe(LOGICAL_SHARD_COUNT);
  });

  it("rejects gaps in shard coverage", () => {
    expect(() =>
      validateMachineMap({
        shards: LOGICAL_SHARD_COUNT,
        machines: [{ id: "only", baseUrl: "https://x.example", shardRanges: [[0, 100]] }],
      }),
    ).toThrow(MachineMapError);
  });

  it("rejects overlapping ownership", () => {
    expect(() =>
      validateMachineMap({
        shards: LOGICAL_SHARD_COUNT,
        machines: [
          { id: "a", baseUrl: "https://a.example", shardRanges: [[0, 5000]] },
          { id: "b", baseUrl: "https://b.example", shardRanges: [[4000, 8191]] },
        ],
      }),
    ).toThrow(/two machines/);
  });

  it("rejects a map for the wrong shard space", () => {
    expect(() =>
      validateMachineMap({ shards: 4096, machines: [{ id: "a", baseUrl: "https://a.example", shardRanges: [[0, 4095]] }] }),
    ).toThrow(/13-bit/);
  });
});

describe("machine resolution", () => {
  it("routes each shard to its owning machine", () => {
    expect(machineForShard(0, map).id).toBe("img-a");
    expect(machineForShard(4095, map).id).toBe("img-a");
    expect(machineForShard(4096, map).id).toBe("img-b");
    expect(machineForShard(8191, map).id).toBe("img-b");
  });

  it("resolves keys through the map with a stable shard", () => {
    const placement = placeImageKey("cmp_9/hero.png", map);
    expect(placement.shard).toBe(logicalShardFor("cmp_9/hero.png"));
    expect(placement.path.startsWith(shardSegment(placement.shard))).toBe(true);
    expect(placement.url).toBe(`${placement.machine.baseUrl}/${placement.path}`);
  });

  it("keeps the shard across a machine-map rebalance", () => {
    const rebalanced = validateMachineMap({
      shards: LOGICAL_SHARD_COUNT,
      machines: [
        { id: "img-a", baseUrl: "https://img-a.retroflex.example", shardRanges: [[0, 2047]] },
        { id: "img-b", baseUrl: "https://img-b.retroflex.example", shardRanges: [[2048, 6143]] },
        { id: "img-c", baseUrl: "https://img-c.retroflex.example", shardRanges: [[6144, 8191]] },
      ],
    });
    const before = placeImageKey("cmp_9/hero.png", map);
    const after = placeImageKey("cmp_9/hero.png", rebalanced);
    // Same object, same logical shard and path — only the machine can differ.
    expect(after.shard).toBe(before.shard);
    expect(after.path).toBe(before.path);
  });
});

describe("imageObjectPath", () => {
  it("embeds the shard directory", () => {
    const path = imageObjectPath({ campaignId: "cmp_1", filename: "hero.png" });
    expect(path).toBe(`shard-${String(logicalShardFor("cmp_1/hero.png")).padStart(4, "0")}/cmp_1/hero.png`);
  });

  it("sanitises hostile filenames", () => {
    const path = imageObjectPath({ campaignId: "cmp_1", filename: "../../etc/passwd" });
    expect(path).not.toContain("..");
    expect(path.split("/")[1]).toBe("cmp_1");
    expect(path.split("/").length).toBe(3);
  });

  it("is deterministic per (campaign, filename)", () => {
    const input = { campaignId: "cmp_2", filename: "a b.png" };
    expect(imageObjectPath(input)).toBe(imageObjectPath(input));
  });
});
