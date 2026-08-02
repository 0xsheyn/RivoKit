/**
 * The fiat payout rail — the seam between a settled order and a bank account.
 *
 * WHY THIS IS AN INTERFACE AND NOT A FUNCTION CALL
 *
 * Every off-ramp needs three things RivoKit must never hold: an API key with
 * payout capability, the funds owner's signer, and the beneficiary's PII (IBAN,
 * travel-rule identity). So the rail is INJECTED, exactly like `FundExecutor`
 * and `RebatePayer` — the host supplies an implementation bound to its own
 * credentials, and the orchestrator only decides WHEN to drive it.
 *
 * WHAT STAYS ON RIVOKIT'S SIDE OF THE SEAM
 *
 * The floor. A rail quotes and broadcasts; it does not get to decide whether
 * the seller was paid enough. `quote` reports what a payout would cost and
 * deliver, and `createRivoKit` refuses to `submit` unless the delivered amount
 * clears the order's guaranteed price. Moving that check into the rail would
 * put the one invariant that defines this product inside host-supplied code.
 *
 * THE THREE-STEP SHAPE IS NOT DECORATION
 *
 * Payout quotes expire fast — CPN's live in 30-60 seconds (CLAUDE.md), and a
 * quote that lapses between deciding and broadcasting fails as PAYMENT_EXPIRED
 * after the escrow has already been captured. So anything slow is pulled
 * forward into `ready`: on-chain allowance approvals, warm-up reads, whatever a
 * rail needs that costs a block. By the time `quote` returns, the only work
 * left is `submit`, and the clock has barely started.
 */

/** Where an order's money is meant to end up. */
export type PayoutTarget = "wallet" | "bank";

/**
 * What a rail can actually move, read from the rail rather than hardcoded.
 *
 * Corridor minimums are live data and they drift: CPN refuses 11 USDC to
 * EUR/SEPA while accepting 12, because the limit is enforced against the
 * DESTINATION side and FX moves underneath it. A constant in this repo would be
 * wrong within a week, so `createOrder` asks the rail instead.
 */
export type PayoutLimits = {
  minSourceMinor: bigint;
  maxSourceMinor: bigint;
  /** Token the rail consumes, e.g. "USDC". */
  sourceCurrency: string;
  /** Fiat the beneficiary receives, e.g. "EUR". */
  destinationCurrency: string;
  /** Decimal places of the destination currency — 2 for EUR/USD. */
  destinationScale: number;
};

export type PayoutQuoteRequest = {
  orderId: string;
  /**
   * Fiat the seller must receive, in DESTINATION minor units (see
   * `PayoutLimits.destinationScale`) — not RivoKit's 6-decimal micro-EURC.
   * The caller converts, rounding up, so a rounding artefact can never land
   * below the floor.
   */
  destinationMinor: bigint;
  /** Source token available in the settlement wallet. A ceiling, not a target. */
  availableSourceMinor: bigint;
};

export type PayoutQuote = {
  /** Source token this quote consumes to deliver exactly `destinationMinor`. */
  requiredSourceMinor: bigint;
  destinationMinor: bigint;
  destinationCurrency: string;
  destinationScale: number;
  sourceCurrency: string;
  /** Unix seconds. Past this, `submit` is refused rather than attempted. */
  expiresAt: number;
  /** Opaque rail state, handed back to `submit` untouched. */
  intent: unknown;
};

export type PayoutSubmission = {
  paymentId: string;
  /** The rail's own status word, e.g. CPN's "CRYPTO_FUNDS_PENDING". */
  status: string;
  requiredSourceMinor: bigint;
  destinationMinor: bigint;
  destinationCurrency: string;
  destinationScale: number;
  /** On-chain transaction that moved the source token, when the rail reports one. */
  txHash?: string | undefined;
};

export interface PayoutRail {
  /** Rail family, e.g. "cpn". Persisted so a payout can be traced to its network. */
  readonly id: string;
  /** Corridor key, e.g. "EUR-SEPA". */
  readonly corridor: string;

  limits(): Promise<PayoutLimits>;

  /**
   * Slow pre-work, run BEFORE `quote` so it cannot eat the quote's lifetime.
   * Idempotent by contract: called on every payout, expected to no-op when the
   * rail is already prepared. Optional — a rail with nothing slow omits it.
   */
  ready?(availableSourceMinor: bigint): Promise<void>;

  /**
   * Read-only sizing: what this rail would need to deliver `destinationMinor`,
   * with no payment created and nothing to expire.
   *
   * Exists because sizing a bank-bound order from an FX quote is sizing against
   * the wrong market. The order's buffer has to absorb the spread of the rail
   * that will actually pay out — a different rate, and a different fee
   * schedule, from the swap that would have run on the wallet path. Getting
   * this from the rail is the difference between a buffer that covers the
   * payout and one that happens to.
   *
   * Optional. A rail without it leaves the caller sizing from FX and relying on
   * the buffer being generous enough.
   */
  estimate?(destinationMinor: bigint): Promise<{ requiredSourceMinor: bigint }>;

  /** Read-only. Locks a rate that delivers exactly `destinationMinor`. */
  quote(req: PayoutQuoteRequest): Promise<PayoutQuote>;

  /**
   * IRREVERSIBLE. Broadcasts the payout; the source token leaves the settlement
   * wallet and cannot be recalled. Only ever called after the floor check.
   */
  submit(quote: PayoutQuote): Promise<PayoutSubmission>;

  /**
   * Current rail-side status, for hosts with no webhook endpoint.
   *
   * Optional, and secondary by design: webhooks are what actually drive a
   * payout to its terminal state, and polling exists so a demo or a script can
   * follow one without a public URL. A rail that omits this simply never
   * advances on its own — which is honest, not broken.
   */
  status?(paymentId: string): Promise<PayoutStatus>;
}

export type PayoutStatus = {
  /** The rail's own status word, stored verbatim. */
  status: string;
  /** No further transitions are possible. */
  terminal: boolean;
  /**
   * The rail REPORTS the fiat leg as finished. Only ever true on a terminal
   * success.
   *
   * Read this precisely: it is the rail's assertion, not an observation. No
   * code here can see a bank account, so nothing in RivoKit can confirm the
   * beneficiary was credited — and in Circle's sandbox nothing is, by
   * construction (statuses are driven by magic values, and refund transaction
   * hashes are randomly generated). The artefact that would let a real
   * beneficiary confirm a credit is `fiatNetworkPaymentRef`, below.
   */
  delivered: boolean;
  /**
   * The rail's reference for the fiat transfer, visible on the beneficiary's
   * bank statement. The only handle that connects a payout to something a
   * recipient can actually check.
   */
  fiatNetworkPaymentRef?: string | undefined;
  /**
   * The on-chain transaction that moved the source token, once the rail knows
   * it. Absent at broadcast time — a payout is submitted before it is mined, so
   * the hash only exists on a later read. It matters because a ledger row
   * marked confirmed without a hash cannot be checked against the chain.
   */
  txHash?: string | undefined;
  failureReason?: string | undefined;
};

/**
 * Convert RivoKit's 6-decimal price to a rail's destination scale, rounding UP.
 *
 * The direction is the whole point. RivoKit guarantees the seller a floor, so a
 * value that does not divide evenly must resolve in the SELLER's favour: a
 * floor of 2.5000005 EUR becomes 251 cents, never 250. Rounding down would
 * breach the guarantee by a cent and still pass every other check.
 */
export function toDestinationMinor(priceMinor6: bigint, destinationScale: number): bigint {
  if (destinationScale < 0 || destinationScale > 6 || !Number.isInteger(destinationScale)) {
    throw new RangeError(
      `toDestinationMinor: destinationScale must be an integer in 0..6, got ${destinationScale}`,
    );
  }
  const divisor = 10n ** BigInt(6 - destinationScale);
  const whole = priceMinor6 / divisor;
  return priceMinor6 % divisor === 0n ? whole : whole + 1n;
}

/** The rail could not deliver the order's floor for the money on hand. */
export class PayoutFloorNotMetError extends Error {
  readonly code = "PAYOUT_FLOOR_NOT_MET";
  readonly requiredSourceMinor: bigint;
  readonly availableSourceMinor: bigint;

  constructor(requiredSourceMinor: bigint, availableSourceMinor: bigint, currency: string) {
    super(
      `Payout needs ${requiredSourceMinor} ${currency} to clear the floor but only ${availableSourceMinor} was captured. ` +
        "Nothing was broadcast; the funds stay in the settlement wallet.",
    );
    this.name = "PayoutFloorNotMetError";
    this.requiredSourceMinor = requiredSourceMinor;
    this.availableSourceMinor = availableSourceMinor;
  }
}

/** The quote lapsed before it could be broadcast. Nothing was submitted. */
export class PayoutQuoteExpiredError extends Error {
  readonly code = "PAYOUT_QUOTE_EXPIRED";

  constructor(expiresAt: number, now: number) {
    super(
      `Payout quote expired at ${expiresAt} (now ${now}); refusing to submit. ` +
        "Re-quote and retry — the capture already happened, so the order sits in settlement_pending.",
    );
    this.name = "PayoutQuoteExpiredError";
  }
}
