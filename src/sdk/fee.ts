/**
 * Operator fee arithmetic — how the gasless relay pays for itself.
 *
 * The operator signs and pays gas for every escrow call (authorize, capture,
 * void, refund). On Arc that gas is USDC, so without a fee the operator
 * subsidises every order it relays. Commerce Payments Protocol already has the
 * mechanism: `capture(paymentInfo, amount, feeBps, feeReceiver)` splits the fee
 * off at capture, bounded by the `minFeeBps`/`maxFeeBps` the payer authorized.
 *
 * THE DIRECTION MATTERS. The fee is grossed up onto what the PAYER authorizes,
 * never subtracted from what reaches the seller. Taking it out of the captured
 * amount would shrink the swap input below `priceEUR`, the floored swap would
 * revert, and the currency guarantee (CLAUDE.md §0.4) would be broken by our own
 * fee. So: quote the net that clears the floor, then authorize net/(1 − fee).
 */

/** The fee the escrow will withhold — floor division, exactly as the contract does. */
export function feeOf(amountMinor: bigint, feeBps: number): bigint {
  if (feeBps <= 0) return 0n;
  return (amountMinor * BigInt(feeBps)) / 10_000n;
}

/** What actually reaches the receiver after the escrow withholds the fee. */
export function netOfFee(amountMinor: bigint, feeBps: number): bigint {
  return amountMinor - feeOf(amountMinor, feeBps);
}

export class InvalidFeeError extends Error {
  readonly code = "INVALID_FEE";
  constructor(message: string) {
    super(message);
    this.name = "InvalidFeeError";
  }
}

export function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
    throw new InvalidFeeError(
      `feeBps must be a whole number in 0..9999 (got ${feeBps}). CPP stores it as uint16 bps.`,
    );
  }
}

/**
 * Smallest gross amount whose post-fee remainder still covers `netMinor`.
 *
 * Ceiling division alone is neither sufficient nor minimal: the contract FLOORS
 * the fee, so several gross amounts can leave the same net. Ceiling gives a
 * value known to be safe, then a binary search finds the smallest one that still
 * clears `netMinor` — `netOfFee` is non-decreasing in the amount, which is what
 * makes the search valid. Charging the payer a micro-unit more than necessary
 * would not be dangerous, but there is no reason to.
 */
export function grossUpForFee(netMinor: bigint, feeBps: number): bigint {
  assertFeeBps(feeBps);
  if (feeBps === 0 || netMinor <= 0n) return netMinor;

  const denom = BigInt(10_000 - feeBps);
  let hi = (netMinor * 10_000n + denom - 1n) / denom;
  while (netOfFee(hi, feeBps) < netMinor) hi += 1n;

  let lo = netMinor;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (netOfFee(mid, feeBps) >= netMinor) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}
