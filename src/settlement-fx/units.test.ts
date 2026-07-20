import { describe, expect, it } from "vitest";
import {
  MoneyFormatError,
  computeRebate,
  computeUsdcAmount,
  deriveRate,
  fromDecimalString,
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

  it("menolak nilai negatif", () => {
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

  it("MEMOTONG di bawah 1e-6, tidak membulatkan ke atas", () => {
    // Rounding up here would let a floor check pass on money that never arrives.
    expect(fromDecimalString("29.7509609999")).toBe(29_750_960n);
    expect(fromDecimalString("0.0000009")).toBe(0n);
  });

  it("menolak input tak sah", () => {
    for (const bad of ["", "abc", "-1", "1.2.3", "1e6", " "]) {
      expect(() => fromDecimalString(bad), bad).toThrow(MoneyFormatError);
    }
  });

  it("bolak-balik tanpa kehilangan presisi", () => {
    for (const v of [0n, 1n, 18_500_000n, 999_999_999_999n]) {
      expect(fromDecimalString(toDecimalString(v))).toBe(v);
    }
  });
});

describe("deriveRate", () => {
  it("kurs 1:1 menghasilkan 1_000_000", () => {
    expect(deriveRate(1_000_000n, 1_000_000n)).toBe(1_000_000n);
  });

  it("cocok dengan kuotasi nyata: 20 EURC → 29.75096 USDC", () => {
    // Live quote observed on Arc Testnet.
    expect(deriveRate(20_000_000n, 29_750_960n)).toBe(1_487_548n);
  });

  it("menolak amountIn nol", () => {
    expect(() => deriveRate(0n, 1n)).toThrow(MoneyFormatError);
  });
});

describe("computeUsdcAmount", () => {
  const PRICE = 18_500_000n; // €18.50

  it("tanpa buffer pada kurs 1:1, buyer membayar tepat harga", () => {
    expect(computeUsdcAmount(PRICE, 1_000_000n, 0)).toBe(PRICE);
  });

  it("buffer 150bps menambah 1,5%", () => {
    const withBuffer = computeUsdcAmount(PRICE, 1_000_000n, 150);
    expect(withBuffer).toBe(18_777_500n);
  });

  it("nilai demo PRD: 1 EURC ≈ 1,08 USDC, buffer 150bps → ~20,28 USDC", () => {
    // PRD §14 quotes ~20.28 USDC for €18.50. Its "1.08" is USDC per EURC, so
    // the rate this function wants is the reciprocal: ~0.9259 EURC per USDC.
    const rate = deriveRate(1_080_000n, 1_000_000n); // 1.08 USDC in → 1 EURC out
    const amount = computeUsdcAmount(PRICE, rate, 150);
    expect(Number(amount) / 1e6).toBeCloseTo(20.28, 1);
  });

  it("membalik arah kurs menghasilkan angka yang salah tapi tampak masuk akal", () => {
    // Documents the trap: 1.08 fed directly instead of its reciprocal returns
    // 17.39 — no error, no warning, recipient €2.89 short. This test exists so
    // the hazard stays visible if anyone "simplifies" the API later.
    const wrong = computeUsdcAmount(PRICE, 1_080_000n, 150);
    expect(Number(wrong) / 1e6).toBeCloseTo(17.39, 1);

    const right = computeUsdcAmount(PRICE, deriveRate(1_080_000n, 1_000_000n), 150);
    expect(right).toBeGreaterThan(wrong);
  });

  it("usdcAmountFromQuote tidak bisa dibalik arahnya", () => {
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

  it("menolak rate nol dan buffer negatif", () => {
    expect(() => computeUsdcAmount(PRICE, 0n, 0)).toThrow(MoneyFormatError);
    expect(() => computeUsdcAmount(PRICE, 1_000_000n, -1)).toThrow(MoneyFormatError);
  });
});

describe("computeRebate (invariant 6 PRD §10)", () => {
  it("mengembalikan surplus saat output melebihi harga", () => {
    expect(computeRebate(19_000_000n, 18_500_000n)).toBe(500_000n);
  });

  it("nol saat output tepat sama", () => {
    expect(computeRebate(18_500_000n, 18_500_000n)).toBe(0n);
  });

  it("nol — TIDAK negatif — saat output kurang", () => {
    // A negative rebate would mean billing the buyer twice.
    expect(computeRebate(18_000_000n, 18_500_000n)).toBe(0n);
  });
});
