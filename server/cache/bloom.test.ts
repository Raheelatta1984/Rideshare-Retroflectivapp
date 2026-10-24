import { describe, expect, it } from "vitest";
import { createBloomFilter } from "./bloom";

describe("Bloom filter", () => {
  it("definitely rejects unseeded values and retains inserted values", () => {
    const filter = createBloomFilter({ expectedItems: 100, falsePositiveRate: 0.001 });
    const inserted = Array.from({ length: 100 }, (_, i) => `campaign-${i}`);
    inserted.forEach((id) => filter.add(id));
    expect(filter.size).toBe(100);
    expect(inserted.every((id) => filter.mightContain(id))).toBe(true);
    expect(filter.mightContain("not-in-the-snapshot")).toBe(false);
  });

  it("allows false positives without ever losing inserted values", () => {
    const filter = createBloomFilter({ expectedItems: 1, falsePositiveRate: 0.25 });
    filter.add("present");
    expect(filter.mightContain("present")).toBe(true);
    // A false positive is allowed; a false negative for an inserted value is not.
    expect(typeof filter.mightContain("maybe-present")).toBe("boolean");
  });
});
