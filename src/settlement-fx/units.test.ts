import { describe, expect, it } from "vitest";
import {
  MoneyFormatError,
  computeRebate,
  computeUsdcAmount,
  deriveRate,
  fromDecimalString,
  fromDecimalStringScaled,
  toDecimalString,
  usdcAmountFromQuote,
} from "./units.ts";

describe("toDecimalString", () => {
  it.each([
    [0n, "0"],
    [1n, "0.000001"],
    [18_500_000n, "18.5"],
    [1_000_000n, "1"],
    [29_750_960n, "29.75096"],
    [123_456_789n, "123.456789"],
  ])("%s → %s", (minor, expected) => {
    expect(toDecimalString(minor)).toBe(expected);
  });

  it("rejects a negative value", () => {
    expect(() => toDecimalString(-1n)).toThrow(MoneyFormatError);
  });
});

describe("fromDecimalString", () => {
  it.each([
    ["0", 0n],
    ["1", 1_000_000n],
    ["18.5", 18_500_000n],
    ["29.75096", 29_750_960n],
    ["0.000001", 1n],
  ])("%s → %s", (value, expected) => {
    expect(fromDecimalString(value)).toBe(expected);
  });

  it("TRUNCATES below 1e-6 rather than rounding up", () => {
    // Rounding up here would let a floor check pass on money that never arrives.
    expect(fromDecimalString("29.7509609999")).toBe(29_750_960n);
    expect(fromDecimalString("0.0000009")).toBe(0n);
  });

  it("rejects invalid input", () => {
    for (const bad of ["", "abc", "-1", "1.2.3", "1e6", " "]) {
      expect(() => fromDecimalString(bad), bad).toThrow(MoneyFormatError);
    }
  });

  it("round-trips without losing precision", () => {
    for (const v of [0n, 1n, 18_500_000n, 999_999_999_999n]) {
      expect(fromDecimalString(toDecimalString(v))).toBe(v);
    }
  });
});

describe("deriveRate", () => {
  it("a 1:1 rate yields 1_000_000", () => {
    expect(deriveRate(1_000_000n, 1_000_000n)).toBe(1_000_000n);
  });

  it("matches a real quote: 20 EURC → 29.75096 USDC", () => {
    // Live quote observed on Arc Testnet.
    expect(deriveRate(20_000_000n, 29_750_960n)).toBe(1_487_548n);
  });

  it("rejects a zero amountIn", () => {
    expect(() => deriveRate(0n, 1n)).toThrow(MoneyFormatError);
  });
});

describe("computeUsdcAmount", () => {
  const PRICE = 18_500_000n; // €18.50

  it("with no buffer at a 1:1 rate, the buyer pays exactly the price", () => {
    expect(computeUsdcAmount(PRICE, 1_000_000n, 0)).toBe(PRICE);
  });

  it("buffer 150bps menambah 1,5%", () => {
    const withBuffer = computeUsdcAmount(PRICE, 1_000_000n, 150);
    expect(withBuffer).toBe(18_777_500n);
  });

  it("PRD demo figures: 1 EURC ≈ 1.08 USDC, 150bps buffer → ~20.28 USDC", () => {
    // PRD §14 quotes ~20.28 USDC for €18.50. Its "1.08" is USDC per EURC, so
    // the rate this function wants is the reciprocal: ~0.9259 EURC per USDC.
    const rate = deriveRate(1_080_000n, 1_000_000n); // 1.08 USDC in → 1 EURC out
    const amount = computeUsdcAmount(PRICE, rate, 150);
    expect(Number(amount) / 1e6).toBeCloseTo(20.28, 1);
  });

  it("inverting the rate gives a wrong number that still looks plausible", () => {
    // Documents the trap: 1.08 fed directly instead of its reciprocal returns
    // 17.39 — no error, no warning, recipient €2.89 short. This test exists so
    // the hazard stays visible if anyone "simplifies" the API later.
    const wrong = computeUsdcAmount(PRICE, 1_080_000n, 150);
    expect(Number(wrong) / 1e6).toBeCloseTo(17.39, 1);

    const right = computeUsdcAmount(PRICE, deriveRate(1_080_000n, 1_000_000n), 150);
    expect(right).toBeGreaterThan(wrong);
  });

  it("usdcAmountFromQuote cannot be used in the other direction", () => {
    // Same result, but the argument names carry the direction.
    const viaQuote = usdcAmountFromQuote(
      PRICE,
      { usdcInMinor: 1_080_000n, eurcOutMinor: 1_000_000n },
      150,
    );
    expect(Number(viaQuote) / 1e6).toBeCloseTo(20.28, 1);
  });

  it("SELALU membulatkan ke atas — buyer menanggung sisa pembulatan", () => {
    // A rounding error must never leave the recipient below the floor.
    const rate = 3_000_000n; // deliberately awkward divisor
    const amount = computeUsdcAmount(7n, rate, 0);
    expect(amount * rate).toBeGreaterThanOrEqual(7n * 1_000_000n);
  });

  it("rejects a zero rate and a negative buffer", () => {
    expect(() => computeUsdcAmount(PRICE, 0n, 0)).toThrow(MoneyFormatError);
    expect(() => computeUsdcAmount(PRICE, 1_000_000n, -1)).toThrow(MoneyFormatError);
  });
});

describe("computeRebate (invariant 6 PRD §10)", () => {
  it("returns the surplus when the output beats the price", () => {
    expect(computeRebate(19_000_000n, 18_500_000n)).toBe(500_000n);
  });

  it("is zero when the output matches exactly", () => {
    expect(computeRebate(18_500_000n, 18_500_000n)).toBe(0n);
  });

  it("is zero — NOT negative — when the output falls short", () => {
    // A negative rebate would mean billing the buyer twice.
    expect(computeRebate(18_000_000n, 18_500_000n)).toBe(0n);
  });
});

describe("fromDecimalStringScaled (non-USDC money, e.g. a CPN payout)", () => {
  it("parses a 2dp fiat amount exactly, where scaling by 100 would not", () => {
    expect(fromDecimalStringScaled("12.94", 2)).toBe(1294n);
    expect(fromDecimalStringScaled("8.29", 2)).toBe(829n);
    // Why this cannot go through Number: 8.29 is not representable in binary
    // floating point, so scaling it lands just under the integer.
    expect(8.29 * 100).toBe(828.9999999999999);
    expect(Math.trunc(8.29 * 100)).toBe(828);   // truncating here loses a cent
  });

  it("handles a 0dp currency without inventing decimals", () => {
    expect(fromDecimalStringScaled("1500", 0)).toBe(1500n);
  });

  it("truncates below the scale rather than rounding up", () => {
    // Rounding up would report a payout larger than what settles.
    expect(fromDecimalStringScaled("12.999", 2)).toBe(1299n);
  });

  it("pads a short fraction to the full scale", () => {
    expect(fromDecimalStringScaled("12.9", 2)).toBe(1290n);
    expect(fromDecimalStringScaled("12", 2)).toBe(1200n);
  });

  it("stays identical to the 6dp helper at scale 6", () => {
    expect(fromDecimalStringScaled("29.750960123456789", 6)).toBe(fromDecimalString("29.750960123456789"));
  });

  it("refuses a nonsense scale or a non-decimal", () => {
    expect(() => fromDecimalStringScaled("1.00", -1)).toThrow(MoneyFormatError);
    expect(() => fromDecimalStringScaled("1.00", 1.5)).toThrow(MoneyFormatError);
    expect(() => fromDecimalStringScaled("-1.00", 2)).toThrow(MoneyFormatError);
    expect(() => fromDecimalStringScaled("12,94", 2)).toThrow(MoneyFormatError);
  });
});
