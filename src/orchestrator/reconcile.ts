/**
 * Reconciliation — bring the DB's belief about an order back in line with the
 * chain after an interruption.
 *
 * The chain is the source of truth for funds; a `*_pending` state only means
 * RivoKit started an async move (a bridge, a Gateway deposit, an escrow
 * authorize) and has not yet confirmed the result. A crash between the move and
 * the state write leaves the order stuck. This sweep re-derives the truth and
 * advances the order, and is safe to run repeatedly — every write it makes is a
 * checked state transition, and the payment rows it would touch are keyed by a
 * unique nonce, so a replay is a no-op rather than a double count.
 *
 * The two pending states are NOT symmetric:
 *
 *   funding_pending — the money should have landed in escrow. That is fully
 *                     re-derivable: ask the escrow whether it holds the
 *                     authorized amount. If it does, the order is funded.
 *
 *   refund_pending  — the escrow was ALREADY returned to the payer; what may
 *                     still be outstanding is the bridge back to receivingChain.
 *                     Escrow state says nothing about that leg, so this sweep
 *                     will not silently mark such an order refunded. It reports
 *                     it for a caller-driven bridge retry — closing it here on
 *                     escrow evidence alone would claim the payer got their
 *                     money on the origin chain when they might not have.
 */
import type { Hex } from "viem";
import type { OrderRecord, OrderStore } from "./order-store.ts";
import type { PaymentState } from "../escrow/operations.ts";

export type ReconcileDeps = {
  store: Pick<OrderStore, "listPending" | "transition" | "get">;
  escrow: { getPaymentState(hash: Hex): Promise<PaymentState> };
};

export type ReconcileAction =
  | "advanced_to_funded"
  | "still_funding"
  | "needs_bridge_retry"
  | "blocked_no_hash"
  | "skipped";

export type ReconcileResult = {
  orderId: string;
  from: string;
  action: ReconcileAction;
  detail?: string;
};

/**
 * Reconcile a single order against on-chain state. Idempotent: an order already
 * in a settled state is skipped, and a re-run of a still-pending order simply
 * re-reads the chain.
 */
export async function reconcileOrder(deps: ReconcileDeps, order: OrderRecord): Promise<ReconcileResult> {
  const base = { orderId: order.id, from: order.state };

  if (order.state === "funding_pending") {
    if (!order.payment_info_hash) {
      return { ...base, action: "blocked_no_hash", detail: "order tanpa payment_info_hash" };
    }
    const ps = await deps.escrow.getPaymentState(order.payment_info_hash as Hex);
    // Escrow holds the authorized amount → the funding move landed; promote.
    if (ps.capturableAmount >= BigInt(order.max_amount)) {
      await deps.store.transition(order.id, "funded", { fundedAt: new Date() });
      return { ...base, action: "advanced_to_funded", detail: `escrow menahan ${ps.capturableAmount}` };
    }
    return { ...base, action: "still_funding", detail: `escrow ${ps.capturableAmount} < ${order.max_amount}` };
  }

  if (order.state === "refund_pending") {
    // The origin-chain leg cannot be verified from escrow state; hand it back
    // for a bridge retry rather than closing it on incomplete evidence.
    return { ...base, action: "needs_bridge_retry", detail: `bridge-back ke ${order.receiving_chain} belum terkonfirmasi` };
  }

  return { ...base, action: "skipped" };
}

/**
 * Sweep every pending order. Returns one result per order; the caller decides
 * what to do with `needs_bridge_retry` (it needs the payer's adapters, which
 * this layer does not hold).
 */
export async function reconcilePending(deps: ReconcileDeps): Promise<ReconcileResult[]> {
  const pending = await deps.store.listPending();
  const out: ReconcileResult[] = [];
  for (const order of pending) {
    out.push(await reconcileOrder(deps, order));
  }
  return out;
}
