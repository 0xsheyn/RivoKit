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
  "shipped",
  "released",
  "refund_pending",
  "refunded",
  "failed",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

/** States from which nothing further can happen. */
export const TERMINAL_STATES: readonly OrderState[] = ["refunded"];

const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  // Funding submitted, or abandoned before it ever started.
  created: ["funding_pending", "failed"],

  // Cross-chain funding is async — CCTP attestation can take minutes.
  funding_pending: ["funded", "failed"],

  // Held in escrow. `shipped` is optional: digital goods release immediately.
  funded: ["shipped", "released", "refund_pending", "failed"],

  shipped: ["released", "refund_pending", "failed"],

  // EXTENSION beyond API.md, which draws `released` as terminal.
  //
  // The escrow allows refund AFTER capture, until refundExpiry — and Phase 1's
  // exit criterion is exactly fund→capture→refund. Note this is a different
  // and costlier path than a pre-capture void: OperatorRefundCollector pulls
  // the tokens from the OPERATOR's own balance, not from escrow.
  released: ["refund_pending"],

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
      `Transisi tidak sah: ${from} → ${to}. Yang diizinkan dari ${from}: ` +
        (TRANSITIONS[from].length ? TRANSITIONS[from].join(", ") : "(tidak ada — state terminal)"),
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
  return state === "funded" || state === "shipped" || state === "released";
}
