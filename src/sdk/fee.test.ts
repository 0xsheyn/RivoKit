import { describe, expect, it } from "vitest";
import { assertFeeBps, feeOf, grossUpForFee, InvalidFeeError, netOfFee } from "./fee.ts";

describe("feeOf", () => {
  it("floors like the contract does", () => {
    // 2.100001 USDC at 25 bps = 5250.0025 micro → 5250, not 5251.
    expect(feeOf(2_100_001n, 25)).toBe(5250n);
  });

  it("is zero for a zero fee", () => {
    expect(feeOf(2_100_000n, 0)).toBe(0n);
  });
});

describe("grossUpForFee", () => {
  it("leaves the amount alone when there is no fee", () => {
    expect(grossUpForFee(2_100_000n, 0)).toBe(2_100_000n);
  });

  it("never leaves the receiver short of the quoted net", () => {
    // The invariant the floored swap depends on: whatever the escrow withholds,
    // what lands on the receiver still clears the amount that priced the order.
    for (const feeBps of [1, 25, 100, 250, 999, 5_000, 9_999]) {
      for (const net of [1n, 7n, 999_999n, 2_100_000n, 3_500_000n, 123_456_789n]) {
        const gross = grossUpForFee(net, feeBps);
        expect(netOfFee(gross, feeBps)).toBeGreaterThanOrEqual(net);
      }
    }
  });

  it("is minimal — one micro-unit less would fall short", () => {
    for (const feeBps of [25, 250, 1_000]) {
      for (const net of [2_100_000n, 3_500_000n, 999_999n]) {
        const gross = grossUpForFee(net, feeBps);
        expect(netOfFee(gross - 1n, feeBps)).toBeLessThan(net);
      }
    }
  });

  it("charges the payer roughly the fee, not more", () => {
    // 25 bps on 2.1 USDC ≈ 5250 micro-USDC of markup.
    const gross = grossUpForFee(2_100_000n, 25);
    expect(gross - 2_100_000n).toBeLessThanOrEqual(5_500n);
  });
});

describe("assertFeeBps", () => {
  it("rejects a fee that is not a whole bps in range", () => {
    for (const bad of [-1, 10_000, 12_000, 2.5, Number.NaN]) {
      expect(() => assertFeeBps(bad)).toThrow(InvalidFeeError);
    }
  });

  it("accepts the boundaries", () => {
    expect(() => assertFeeBps(0)).not.toThrow();
    expect(() => assertFeeBps(9_999)).not.toThrow();
  });
});
