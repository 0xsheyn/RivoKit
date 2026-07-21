/**
 * Refund: return the payer's money, then put it back where it came from.
 *
 * Two escrow mechanisms, chosen by whether the funds were ever captured:
 *   void    — the authorization is still live; escrow releases straight back to
 *             the payer. Cheap: nothing is pulled from the operator.
 *   refund  — the funds were already captured, so OperatorRefundCollector pulls
 *             them from the OPERATOR's balance to repay the payer. Costs the
 *             operator, and needs an ERC-20 allowance to the collector.
 *
 * Either way the payer ends up holding USDC on Arc. Invariant 5 (PRD §10) says a
 * refund returns to the order's recorded `receivingChain`, so when that chain is
 * not Arc the money is bridged back — Arc → receivingChain, signed by the payer,
 * since it is the payer's USDC now.
 *
 * The escrow step is irreversible and the bridge is not atomic with it. If the
 * bridge is interrupted the payer already holds their money on Arc — safe, just
 * not yet on the origin chain. That is `refund_pending`, recoverable by retrying
 * the bridge; it is NOT a lost refund and must never be reported as a failure.
 */
import type { Address } from "viem";
import type { Escrow } from "../escrow/operations.ts";
import type { PaymentInfo } from "../escrow/payment-info.ts";
import type { Bridge, BridgeParams, BridgeResult } from "../funding/bridge.ts";
import { BridgeStuckError, BridgeFailedError } from "../funding/bridge.ts";
import { assertTransition, type OrderState } from "./state-machine.ts";

export type RefundMechanism = "void" | "refund";

export type RefundDeps = {
  escrow: Escrow;
  /** Only needed when the refund must bridge back off Arc. */
  bridge?: Bridge;
};

export type RefundRequest = {
  paymentInfo: PaymentInfo;
  amountMinor: bigint;
  currentState: OrderState;
  mechanism: RefundMechanism;
  /** Required for mechanism "refund" (post-capture); ignored for "void". */
  refundCollector?: Address;
  /**
   * Arc → receivingChain bridge, payer-signed. Omit when receivingChain is Arc:
   * the escrow step already left the funds there, so there is nothing to move.
   */
  bridgeBack?: BridgeParams;
};

export type RefundOutcome = {
  mechanism: RefundMechanism;
  /** The escrow void/refund tx — proof the money left escrow back to the payer. */
  escrowTxHash?: string | undefined;
  /** Present when a bridge-back ran. */
  burnTxHash?: string | undefined;
  mintTxHash?: string | undefined;
  bridged: boolean;
  /**
   * refunded        — money is fully back on receivingChain (or already on Arc
   *                   when that IS the receiving chain).
   * refund_pending  — escrow returned the funds to the payer on Arc, but the
   *                   bridge back to the origin chain has not completed.
   */
  status: "refunded" | "refund_pending";
  reason?: string | undefined;
  /**
   * When the bridge-back stalled after burning, the resumable result from the
   * BridgeStuckError — hand it to `bridge.retry` to continue from attestation
   * rather than burning a second time. Absent for a clean (nothing-moved) fail.
   */
  stuckPrevious?: unknown;
};

function requireCollector(c?: Address): Address {
  if (!c) throw new Error('refund: mechanism "refund" butuh refundCollector');
  return c;
}

export async function refund(deps: RefundDeps, req: RefundRequest): Promise<RefundOutcome> {
  // Refuse an illegal lifecycle move before touching the chain.
  assertTransition(req.currentState, "refund_pending");

  // 1. Escrow side — irreversible. After this the payer holds USDC on Arc.
  const escrowTx =
    req.mechanism === "void"
      ? await deps.escrow.void(req.paymentInfo)
      : await deps.escrow.refund(req.paymentInfo, req.amountMinor, requireCollector(req.refundCollector));

  // 2. receivingChain is Arc → nothing to bridge, the funds are already home.
  if (!req.bridgeBack) {
    return {
      mechanism: req.mechanism,
      escrowTxHash: escrowTx.txHash,
      bridged: false,
      status: "refunded",
    };
  }

  if (!deps.bridge) {
    throw new Error("refund: bridgeBack diminta tapi tidak ada bridge di deps");
  }

  // 3. Bridge back to the origin chain, signed by the payer.
  try {
    const res: BridgeResult = await deps.bridge.execute(req.bridgeBack);
    const ok = res.state === "success";
    return {
      mechanism: req.mechanism,
      escrowTxHash: escrowTx.txHash,
      burnTxHash: res.burnTxHash,
      mintTxHash: res.mintTxHash,
      bridged: ok,
      status: ok ? "refunded" : "refund_pending",
      reason: ok ? undefined : `bridge state ${res.state}`,
    };
  } catch (e) {
    // The escrow refund already succeeded — the payer has their money on Arc.
    // Whether the bridge is stuck (funds in flight) or failed before burning
    // (nothing moved), the refund itself is NOT lost: only the origin-chain leg
    // is pending. Surface that as refund_pending, never as an error.
    if (e instanceof BridgeStuckError || e instanceof BridgeFailedError) {
      return {
        mechanism: req.mechanism,
        escrowTxHash: escrowTx.txHash,
        bridged: false,
        status: "refund_pending",
        reason: e.message,
        // Only a stuck (already-burned) bridge is resumable; a clean failure moved nothing.
        stuckPrevious: e instanceof BridgeStuckError ? e.detail : undefined,
      };
    }
    throw e;
  }
}

export type Refund = typeof refund;
