/**
 * Order state machine.
 *
 * The chain is the source of truth for FUNDS; this machine is the source of
 * truth for what RivoKit believes about an order. Its job is to make illegal
 * sequences unrepresentable — a `capture` on an unfunded order must be refused
 * here, before it reaches the escrow and reverts.
 *
 * Base diagram: API.md §OrderState. Two edges are deliberately wider than that
 * diagram, both documented at their definition below.
 */

export const ORDER_STATES = [
  "created",
  "funding_pending",
  "funded",
  "settlement_pending",
  "shipped",
  "released",
  "payout_pending",
  "paid_out",
  "refund_pending",
  "refunded",
  "failed",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  // Funding submitted, or abandoned before it ever started.
  created: ["funding_pending", "failed"],

  // Cross-chain funding is async — CCTP attestation can take minutes.
  funding_pending: ["funded", "failed"],

  // Held in escrow. `shipped` is optional: digital goods release immediately.
  funded: ["shipped", "released", "payout_pending", "settlement_pending", "refund_pending", "failed"],

  // Captured, but the swap has not delivered the promised currency yet.
  //
  // The escrow is already empty and void/reclaim no longer apply, so this is
  // NOT recoverable by returning to `funded`. The only ways out are retrying
  // the swap, or giving up and refunding from the operator's own balance.
  // The escrow is already empty and void/reclaim no longer apply, so a stuck
  // settlement can still reach a bank: the USDC sitting with the receiver is
  // exactly what the off-ramp consumes.
  settlement_pending: ["released", "payout_pending", "refund_pending", "failed"],

  shipped: ["released", "payout_pending", "settlement_pending", "refund_pending", "failed"],

  // EXTENSION beyond API.md, which draws `released` as terminal.
  //
  // The escrow allows refund AFTER capture, until refundExpiry — and Phase 1's
  // exit criterion is exactly fund→capture→refund. Note this is a different
  // and costlier path than a pre-capture void: OperatorRefundCollector pulls
  // the tokens from the OPERATOR's own balance, not from escrow.
  released: ["refund_pending"],

  // The off-ramp has been BROADCAST and cannot be recalled. The seller's USDC
  // has left their wallet; the fiat leg is with the payment network, which
  // reports asynchronously (minutes for SEPA, and an RFI can stretch it).
  //
  // There is no edge back to `released`: that state means EURC was delivered on
  // Arc, and on this path no swap ever ran. `settlement_pending` IS reachable,
  // and it is where a FAILED payment lands — CPN returns the USDC to the refund
  // address, which is the settlement wallet, so the order is once again
  // "captured, holding USDC, not yet in the promised currency". Exactly what
  // that state has always meant, reached by a different road.
  payout_pending: ["paid_out", "settlement_pending", "failed"],

  // Terminal, and deliberately so. Fiat has left the payment network for the
  // beneficiary's bank; no operator refund can pull it back, and offering
  // `refund_pending` here would imply a reversal RivoKit cannot perform.
  paid_out: [],

  refund_pending: ["refunded", "failed"],

  refunded: [],

  // EXTENSION beyond API.md, which draws `failed` as terminal.
  //
  // `failed` covers recoverable conditions — most importantly FLOOR_NOT_MET,
  // where the swap reverted and the funds are still safe in escrow. The docs
  // say the orchestrator retries and then refunds (INTEGRATION.md §7), so the
  // order must be able to leave this state. Treating `failed` as terminal
  // would strand those funds.
  failed: ["refund_pending", "funded"],
};

export class InvalidStateTransition extends Error {
  readonly code = "INVALID_STATE";
  // Assigned in the body rather than as parameter properties: Node runs .ts in
  // strip-only mode and rejects `constructor(readonly x: T)`.
  readonly from: OrderState;
  readonly to: OrderState;

  constructor(from: OrderState, to: OrderState) {
    super(
      `Invalid transition: ${from} → ${to}. Allowed from ${from}: ` +
        (TRANSITIONS[from].length ? TRANSITIONS[from].join(", ") : "(none — terminal state)"),
    );
    this.name = "InvalidStateTransition";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws `InvalidStateTransition` rather than returning false. */
export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new InvalidStateTransition(from, to);
}

export function nextStates(from: OrderState): readonly OrderState[] {
  return TRANSITIONS[from];
}

export function isTerminal(state: OrderState): boolean {
  return TRANSITIONS[state].length === 0;
}

/**
 * True once funds are known to sit in escrow.
 *
 * Guards PRD §10 invariant 3: funds may only be released after funding has
 * settled. `funding_pending` is NOT funded — the attestation may still fail.
 */
export function isFunded(state: OrderState): boolean {
  return (
    state === "funded" ||
    state === "settlement_pending" ||
    state === "shipped" ||
    state === "released" ||
    state === "payout_pending" ||
    state === "paid_out"
  );
}

/**
 * True when funds have LEFT escrow and cannot be recovered by void or reclaim.
 *
 * Past this point a return to the payer costs the operator its own balance
 * (refund pulls from the operator, not from escrow), so the cheap cancellation
 * path is gone.
 */
export function isCaptured(state: OrderState): boolean {
  return (
    state === "settlement_pending" ||
    state === "released" ||
    state === "payout_pending" ||
    state === "paid_out"
  );
}

/**
 * True once the fiat leg is irreversible — broadcast, or already delivered.
 *
 * Distinct from `isCaptured`, which only says funds left escrow. Capture can
 * still be undone by an operator-funded refund; a broadcast off-ramp cannot,
 * because the USDC has left the seller's wallet for a payment network RivoKit
 * does not control. Callers that offer a refund must check this, not just
 * `isCaptured`.
 */
export function isOffRamped(state: OrderState): boolean {
  return state === "payout_pending" || state === "paid_out";
}
