import { describe, expect, it } from "vitest";
import { toDestinationMinor } from "./rail.ts";

describe("toDestinationMinor — converting a floor into a rail's scale", () => {
  it("converts an exact micro-EURC floor to cents", () => {
    expect(toDestinationMinor(2_500_000n, 2)).toBe(250n);
    expect(toDestinationMinor(12_000_000n, 2)).toBe(1200n);
  });

  // The direction is the invariant, not an implementation detail. RivoKit
  // guarantees a floor, so anything that does not divide evenly has to resolve
  // in the SELLER's favour — rounding down would breach the guarantee by a cent
  // while passing every other check in the system.
  it("rounds UP whenever precision is lost", () => {
    expect(toDestinationMinor(2_500_001n, 2)).toBe(251n);
    expect(toDestinationMinor(2_509_999n, 2)).toBe(251n);
    expect(toDestinationMinor(1n, 2)).toBe(1n);
  });

  it("never returns less than the floor when converted back", () => {
    for (const micro of [1n, 999_999n, 2_500_001n, 12_345_678n, 99n]) {
      const cents = toDestinationMinor(micro, 2);
      expect(cents * 10_000n).toBeGreaterThanOrEqual(micro);
    }
  });

  it("is exact at the same scale", () => {
    expect(toDestinationMinor(2_500_001n, 6)).toBe(2_500_001n);
  });

  it("handles a zero-decimal currency", () => {
    expect(toDestinationMinor(1_000_000n, 0)).toBe(1n);
    expect(toDestinationMinor(1_000_001n, 0)).toBe(2n);
  });

  it("rejects a scale it cannot represent", () => {
    expect(() => toDestinationMinor(1n, 7)).toThrow(RangeError);
    expect(() => toDestinationMinor(1n, -1)).toThrow(RangeError);
    expect(() => toDestinationMinor(1n, 1.5)).toThrow(RangeError);
  });
});
