/**
 * Unit conversion at the App Kit boundary.
 *
 * RivoKit holds money as integer minor units (CLAUDE.md §0.3) — €18.50 is the
 * bigint 18_500_000n. App Kit speaks decimal strings — "18.5". Both are right
 * for their own side; the danger is the seam between them, which is where
 * precision quietly disappears.
 *
 * Verified against the live service: `amountIn: "1000000"` is ONE MILLION
 * tokens, not one token. CLAUDE.md §5's example is wrong by 10^6, and following
 * it quotes against a million-token slippage curve — the observed rate moved
 * from 1.488 to 1.028, a ~31% error.
 *
 * Rules here:
 *   - never use Number() on money
 *   - conversion into minor units always ROUNDS DOWN, so a rounding error can
 *     only ever favour the recipient's floor, never breach it
 */

/** USDC and EURC both use 6 decimals on Arc. */
export const DECIMALS = 6;

const SCALE = 10n ** BigInt(DECIMALS);

export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyFormatError";
  }
}

/**
 * Minor units → the decimal string App Kit expects.
 *
 * 18_500_000n → "18.5"
 */
export function toDecimalString(minorUnits: bigint): string {
  if (minorUnits < 0n) throw new MoneyFormatError("a money amount cannot be negative");

  const whole = minorUnits / SCALE;
  const fraction = minorUnits % SCALE;
  if (fraction === 0n) return whole.toString();

  const padded = fraction.toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${padded}`;
}

/**
 * Decimal string → minor units, truncating anything below 1e-6.
 *
 * Truncation is deliberate. The service returns values like
 * "29.750960123456789"; rounding up could report an output that is one unit
 * larger than what actually settles, which is exactly the kind of error that
 * would make a floor check pass when it should fail.
 */
export function fromDecimalString(value: string): bigint {
  return fromDecimalStringScaled(value, DECIMALS);
}

/**
 * The same conversion at an arbitrary scale, for money that is not USDC/EURC.
 *
 * CPN pays out in currencies with their own exponents — EUR/BRL/MXN/USD are 2dp
 * today, and a 0dp currency would silently break anything that assumed 6. The
 * scale therefore travels with the amount instead of being baked in.
 *
 * Truncation and validation are identical to the 6dp path: parse as strings,
 * never through Number: 8.29 * 100 is 828.9999999999999, and truncating that
 * loses a cent.
 */
export function fromDecimalStringScaled(value: string, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new MoneyFormatError(`scale must be an integer in 0..18, got ${scale}`);
  }
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyFormatError(`not a valid positive decimal: "${value}"`);
  }

  // The regex above guarantees both parts, but noUncheckedIndexedAccess is
  // right to insist — split() has no such guarantee in the type system.
  const parts = trimmed.split(".");
  const whole = parts[0] ?? "0";
  const fraction = parts[1] ?? "";

  const truncated = fraction.slice(0, scale).padEnd(scale, "0");
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(truncated || "0");
}

/**
 * Exchange rate as a scaled integer: how many minor units of `out` per ONE
 * whole unit of `in`.
 *
 * Derived from a quote rather than a price feed, because the quote is what the
 * swap will actually honour. Quote sizes must match the real order size —
 * quoting 1 unit and applying that rate to 1,000,000 is how the 31% error above
 * happened.
 */
export function deriveRate(amountInMinor: bigint, amountOutMinor: bigint): bigint {
  if (amountInMinor <= 0n) throw new MoneyFormatError("amountIn must be > 0 to derive a rate");
  return (amountOutMinor * SCALE) / amountInMinor;
}

/**
 * How much USDC the buyer must pay to clear `priceEUR`, with a buffer.
 *
 *   usdcAmount = priceEUR / rate × (1 + bufferBps/10000)
 *
 * ROUNDS UP: the buyer must cover the floor, so any rounding error has to land
 * on the payer's side, never leaving the recipient short.
 *
 * DIRECTION MATTERS, and getting it backwards is not loud. `rate` here is
 * EURC OUT per one whole USDC IN — the direction the settlement swap actually
 * runs. It is NOT the "1 EURC = 1.08 USDC" figure quoted in PRD §14, which is
 * that number's reciprocal (~0.926).
 *
 * Feeding 1.08 in place of 0.926 yields 17.39 USDC instead of 20.28 — a
 * plausible-looking number that underpays the recipient by €2.89. Prefer
 * `usdcAmountFromQuote`, which takes the quote pair and cannot be inverted.
 */
export function computeUsdcAmount(
  priceEURMinor: bigint,
  rateEurcPerUsdc: bigint,
  bufferBps: number,
): bigint {
  if (rateEurcPerUsdc <= 0n) throw new MoneyFormatError("rate must be > 0");
  if (bufferBps < 0) throw new MoneyFormatError("bufferBps cannot be negative");

  const base = ceilDiv(priceEURMinor * SCALE, rateEurcPerUsdc);
  return ceilDiv(base * BigInt(10_000 + bufferBps), 10_000n);
}

/**
 * Same calculation, taken straight from a USDC→EURC quote.
 *
 * Preferred over `computeUsdcAmount`: the arguments carry their own direction,
 * so the reciprocal mistake above is not expressible. Quote at a size close to
 * the real order — rates move sharply with size on thin testnet liquidity.
 */
export function usdcAmountFromQuote(
  priceEURMinor: bigint,
  quote: { usdcInMinor: bigint; eurcOutMinor: bigint },
  bufferBps: number,
): bigint {
  return computeUsdcAmount(
    priceEURMinor,
    deriveRate(quote.usdcInMinor, quote.eurcOutMinor),
    bufferBps,
  );
}

/** Rebate = max(0, actualOutput − priceEUR). PRD §10 invariant 6. */
export function computeRebate(actualOutputMinor: bigint, priceEURMinor: bigint): bigint {
  const surplus = actualOutputMinor - priceEURMinor;
  return surplus > 0n ? surplus : 0n;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
