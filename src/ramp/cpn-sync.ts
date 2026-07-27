/**
 * Fold a verified CPN webhook into the stored cash-out.
 *
 * `applyPaymentEvent` decides what a webhook MEANS; this decides what gets
 * written. Keeping them apart matters: the reducer is pure and exhaustively
 * tested, and the only thing that touches the database is the thin layer here,
 * which writes exactly when — and only when — the reducer says the state moved.
 *
 * Everything this refuses is as important as what it accepts:
 *
 *   - an event for a payment we never recorded is `unknown`, not an insert.
 *     CPN's key is shared across a corridor; a webhook for someone else's
 *     payment must not conjure a row.
 *   - a duplicate, a late arrival after a terminal state, or an out-of-order
 *     event writes NOTHING. At-least-once delivery is normal, so "we already
 *     knew" has to be a boring no-op rather than a regression.
 *   - an RFI rejection fails the payment; an open RFI is recorded but does not
 *     move the payment state, because the payment is blocked, not finished.
 *
 * The caller (an HTTP route) is responsible for verifying the signature FIRST —
 * `verifyAndInterpretCpn` — so nothing here ever sees an unverified body.
 */
import type { CpnPaymentRecord, OrderStore } from "../orchestrator/order-store.ts";
import { applyPaymentEvent, rfiEffect, type CpnEvent } from "./cpn-state.ts";

export type CpnSyncStore = Pick<OrderStore, "getCpnPayment" | "advanceCpnPayment" | "recordEvent">;

/** Why an event changed nothing — the reducer's own vocabulary. */
export type CpnIgnoredReason = "no-op" | "duplicate" | "illegal" | "not-payment";

export type CpnSyncResult =
  /** The stored payment moved to a new state and was written. */
  | { status: "advanced"; paymentId: string; from: string; to: string; record: CpnPaymentRecord }
  /** Recognised, but nothing to write — duplicate, out-of-order, or metadata. */
  | { status: "ignored"; paymentId: string; reason: CpnIgnoredReason }
  /** No payment id on the event, or none stored under it. */
  | { status: "unknown"; paymentId: string | null };

/**
 * Apply one verified CPN event.
 *
 * The event is always recorded — even when it changes nothing — so the audit
 * trail shows what CPN actually said, not only the transitions we accepted.
 */
export async function applyCpnEventToStore(
  store: CpnSyncStore,
  event: CpnEvent,
): Promise<CpnSyncResult> {
  const paymentId = event.paymentId ?? null;

  await store.recordEvent({
    type: event.notificationType,
    payload: event.raw,
    // Only a verified event reaches this function; the route enforces that.
    sigVerified: true,
  });

  if (!paymentId) return { status: "unknown", paymentId: null };

  const current = await store.getCpnPayment(paymentId);
  if (!current) return { status: "unknown", paymentId };

  // An RFI rejection is the one non-payment event that can end a payment. It
  // arrives on the `rfi` component, so the payment reducer would call it
  // "not-payment" and drop it.
  const rfi = rfiEffect(event);
  if (rfi?.failsPayment) {
    if (current.status === "COMPLETED" || current.status === "FAILED") {
      return { status: "ignored", paymentId, reason: "illegal" };
    }
    const record = await store.advanceCpnPayment(paymentId, "FAILED", {
      failureReason: `RFI ${rfi.state}`,
    });
    return { status: "advanced", paymentId, from: current.status, to: "FAILED", record };
  }

  const outcome = applyPaymentEvent(current.status, event);
  if (!outcome.changed) {
    return { status: "ignored", paymentId, reason: outcome.reason };
  }

  const record = await store.advanceCpnPayment(paymentId, outcome.state);
  return { status: "advanced", paymentId, from: current.status, to: outcome.state, record };
}
