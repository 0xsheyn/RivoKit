/**
 * The payout record — what happened (or still must happen) on the fiat leg.
 *
 * This type used to live in `mock-payout.ts` and describe one thing only: a
 * hand-off RivoKit could not execute. Now there are two outcomes and they must
 * stay distinguishable at a glance, in the database, and in the UI:
 *
 *   kind "mock" — nobody moved fiat. An instruction for the host to run.
 *   kind "cpn"  — a real payout was BROADCAST on a payment network. Money left.
 *
 * The labelling discipline that guarded the mock (CLAUDE.md §4: every mock must
 * be obvious) is unchanged; it is now symmetric. A mock carries `label: "MOCK"`
 * and `executed: false` and cannot claim otherwise without a caller overriding
 * both on purpose. A live payout carries `label: "LIVE"` and a `reference` — a
 * payment id on a real network — so the claim is falsifiable: anyone can query
 * the rail and check it. A "live" payout with no reference is not something
 * this module will produce, and the database rejects it too.
 *
 * `executed` means BROADCAST, not DELIVERED. The fiat leg is asynchronous —
 * SEPA runs minutes behind, and an RFI can hold a payment for far longer — so
 * the terminal answer lives in `reference.status`, which the webhook path
 * advances. Reading `executed: true` as "the seller has the money" would be a
 * misreading this comment exists to prevent.
 */
import type { Address } from "viem";

/**
 * "mock" is reserved for the non-executing hand-off. Anything else is a live
 * rail's id — "cpn" today. The `(string & {})` arm keeps that open without
 * losing autocomplete on the two names that actually exist.
 */
export type PayoutKind = "mock" | "cpn" | (string & {});

export type PayoutInstruction = {
  kind: PayoutKind;
  /** Banner text. "MOCK" iff `kind` is "mock" — the two cannot disagree. */
  label: "MOCK" | "LIVE";
  orderId: string;
  /** Who the fiat is owed to — the on-chain receiver of the settled funds. */
  beneficiary: Address;
  /** What RivoKit delivered on-chain, and where. */
  source: {
    currency: string;
    chain: string;
    amountMinor: bigint;
    settlementTxHash?: string | undefined;
  };
  /**
   * The fiat leg. `estimated` is true when the figure is a nominal 1:1
   * conversion nobody has quoted, and false once a rail has locked a rate and
   * this is the amount it will actually deliver.
   */
  target: {
    currency: string;
    amountMinor: bigint;
    /** Decimal places of `amountMinor` — 2 for EUR/USD, 6 for micro-EURC. */
    scale: number;
    estimated: boolean;
  };
  /** True once a payout has been broadcast. NOT a claim that fiat has landed. */
  executed: boolean;
  /**
   * The handle that makes a live payout checkable against the network. Null for
   * mocks, because there is nothing to check.
   */
  reference: {
    rail: string;
    corridor: string;
    paymentId: string;
    /** The rail's own status word, advanced by the webhook path. */
    status: string;
    txHash?: string | undefined;
    /**
     * The rail's reference for the fiat transfer, as it appears on the
     * beneficiary's bank statement.
     *
     * Stored because the fiat leg is the one leg nothing here can observe. The
     * on-chain half is checkable by anyone with `txHash`; the fiat half is only
     * checkable by the recipient, and this is what they would match it against.
     * Absent until the rail issues one — and rails that carry `refCode` in the
     * memo may never issue one at all.
     */
    fiatNetworkPaymentRef?: string | undefined;
  } | null;
  disclaimer: string;
  createdAt: number;
};

export type LivePayoutParams = {
  orderId: string;
  beneficiary: Address;
  rail: string;
  corridor: string;
  paymentId: string;
  /** The rail's status immediately after broadcast, e.g. "CRYPTO_FUNDS_PENDING". */
  status: string;
  /** What left the settlement wallet. */
  source: { currency: string; chain: string; amountMinor: bigint; txHash?: string | undefined };
  /** What the rail is contracted to deliver, at the rate its quote locked. */
  target: { currency: string; amountMinor: bigint; scale: number };
  /** Pass the current time in; this module stays pure (no Date.now). */
  now: number;
};

const LIVE_DISCLAIMER =
  "LIVE — this payout was BROADCAST to a payment network and cannot be recalled. " +
  "Broadcast is not delivery: the fiat leg settles asynchronously, so `reference.status` " +
  "is the only statement about whether the beneficiary has been paid.";

/**
 * Record a payout that was actually broadcast.
 *
 * The amount is not flagged `estimated`: unlike the mock's nominal 1:1 figure,
 * this is what a rail quoted and committed to deliver. Everything that makes
 * the claim checkable — rail, corridor, payment id — is required rather than
 * optional, because a live payout nobody can verify is worth less than a mock
 * that admits what it is.
 */
export function livePayout(p: LivePayoutParams): PayoutInstruction {
  if (!p.paymentId) {
    throw new Error("livePayout: paymentId is required — a live payout must be checkable against its rail");
  }
  if (p.target.amountMinor <= 0n) {
    throw new Error("livePayout: target.amountMinor must be > 0 — there is nothing to pay out");
  }
  return {
    kind: p.rail,
    label: "LIVE",
    orderId: p.orderId,
    beneficiary: p.beneficiary,
    source: {
      currency: p.source.currency,
      chain: p.source.chain,
      amountMinor: p.source.amountMinor,
      settlementTxHash: p.source.txHash,
    },
    target: { ...p.target, estimated: false },
    executed: true,
    reference: {
      rail: p.rail,
      corridor: p.corridor,
      paymentId: p.paymentId,
      status: p.status,
      txHash: p.source.txHash,
    },
    disclaimer: LIVE_DISCLAIMER,
    createdAt: p.now,
  };
}

/** True for anything a mock produced — the guard for "never ship a mock as real". */
export function isMockPayout(p: PayoutInstruction): boolean {
  return p.kind === "mock" && p.label === "MOCK" && p.executed === false;
}

/**
 * True for a payout that was actually broadcast on a real rail.
 *
 * Demands the reference too, not just the flags. `executed: true` with nothing
 * to look up is an unverifiable claim, and this codebase treats unverifiable
 * claims as false.
 */
export function isLivePayout(p: PayoutInstruction): boolean {
  return p.kind !== "mock" && p.executed === true && p.reference?.paymentId != null;
}

/**
 * The instruction as it is persisted.
 *
 * Amounts become strings: JSON cannot carry a bigint at all (`JSON.stringify`
 * throws on one), and going through a JS number would reintroduce the rounding
 * that integer minor units exist to prevent. String in, bigint out — the same
 * boundary rule the order store applies to its money columns.
 */
export type PayoutInstructionWire = Omit<PayoutInstruction, "source" | "target"> & {
  source: Omit<PayoutInstruction["source"], "amountMinor"> & { amountMinor: string };
  target: Omit<PayoutInstruction["target"], "amountMinor"> & { amountMinor: string };
};

export function toPayoutWire(p: PayoutInstruction): PayoutInstructionWire {
  return {
    ...p,
    source: { ...p.source, amountMinor: p.source.amountMinor.toString() },
    target: { ...p.target, amountMinor: p.target.amountMinor.toString() },
  };
}

export function fromPayoutWire(w: PayoutInstructionWire): PayoutInstruction {
  return {
    ...w,
    source: { ...w.source, amountMinor: BigInt(w.source.amountMinor) },
    // Rows written before the live rail existed carry neither `scale` nor
    // `reference`. Defaulting on read rather than rewriting the JSONB keeps old
    // instructions readable, and the defaults are what those rows actually
    // were: nominal 1:1 mocks denominated in 6-decimal micro-EURC.
    target: {
      ...w.target,
      amountMinor: BigInt(w.target.amountMinor),
      scale: w.target.scale ?? 6,
      estimated: w.target.estimated ?? true,
    },
    reference: w.reference ?? null,
  };
}
