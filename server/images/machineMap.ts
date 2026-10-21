/**
 * Machine-map loading for the image shard plane.
 *
 * The pure shard/hash logic lives in `src/lib/backend/imageShards.ts` (used
 * by the browser adapter too). This module adds the server-side concerns:
 * reading the map from a file or environment, and turning a placement into a
 * concrete storage location for a machine.
 */

import { readFileSync } from "node:fs";
import {
  LOGICAL_SHARD_COUNT,
  machineForShard,
  placeImageKey,
  validateMachineMap,
  type ImageMachine,
  type ImageMachineMap,
  type ImagePlacement,
} from "../../src/lib/backend/imageShards";

export interface ImagePlane {
  map: ImageMachineMap;
  /** Resolve an object key to its shard + owning machine + path. */
  place(key: string): ImagePlacement;
  /** Machine owning a shard (post-rebalance view). */
  machineFor(shard: number): ImageMachine;
  /** Where a machine should PUT an object it has been handed. */
  uploadUrl(placement: ImagePlacement): string;
}

export function loadMachineMap(source: string | unknown): ImageMachineMap {
  if (typeof source === "string") {
    const raw = readFileSync(source, "utf8");
    return validateMachineMap(JSON.parse(raw));
  }
  return validateMachineMap(source);
}

export function createImagePlane(map: ImageMachineMap): ImagePlane {
  const validated = validateMachineMap(map);
  return {
    map: validated,
    place: (key) => placeImageKey(key, validated),
    machineFor: (shard) => machineForShard(shard, validated),
    uploadUrl: (placement) => placement.url,
  };
}

export { LOGICAL_SHARD_COUNT, validateMachineMap };
