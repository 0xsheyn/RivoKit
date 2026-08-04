/**
 * Reconciliation for standalone cash-outs — the sweep that repairs a
 * `cpn_payments` row when the webhook never came.
 *
 * Two things already close this gap for ORDERS: `reconcileOrder` re-derives an
 * order's state from the chain, and `refreshPayout` re-reads the rail for a
 * payout attached to one. A standalone cash-out has neither. It is broadcast
 * through `createCpnRamp`, lands in `cpn_payments` as `CRYPTO_FUNDS_PENDING`,
 * and from that moment the ONLY thing that moves it is a webhook. No webhook,
 * no movement — the row simply stays wrong, and nothing in the system notices.
 *
 * That is not hypothetical. The webhook endpoint this repo proved against was a
 * quick tunnel; the URL dies with the process and the subscription dies with it.
 * Every cash-out broadcast after that point leaves a row nobody will ever fix.
 *
 * WHAT THIS IS NOT. It is not a replacement for webhooks, and it is not a
 * scheduler. Webhooks remain the source of truth — they arrive in seconds and
 * carry a verified signature, while a poll costs an API call per row and can
 * only see the current state. This is the fallback for hosts that have no
 * public endpoint, and the repair pass for the window where one was down.
 * Wiring it to a timer is the host's job (`scripts/live-cashout-reconcile.mjs`
 * runs it once by hand).
 *
 * SAFE TO RUN REPEATEDLY. Every write goes through `reconcilePaymentStatus`,
 * which only moves forward and never leaves a terminal state, so a second pass
 * over the same rows writes nothing.
 */
import type { CpnPaymentRecord, OrderStore } from "../orchestrator/order-store.ts";
import { isPaymentTerminal, reconcilePaymentStatus } from "./cpn-state.ts";

export type CpnReconcileStore = Pick<
  OrderStore,
  "listCpnPayments" | "advanceCpnPayment" | "recordEvent"
>;

/** Just the read this needs — satisfied by `createCpnRamp(...)`. */
export type CpnStatusReader = {
  status(paymentId: string): Promise<{ status: string }>;
};

export type CpnReconcileAction =
  /** The rail reported a later state than we held, and the row was written. */
  | "advanced"
  /** The rail agrees with what we already had. */
  | "unchanged"
  /** The rail reported something older, unknown, or behind a terminal state. */
  | "ignored"
  /** The rail could not be read at all — the row is untouched and still owed. */
  | "unreachable";

export type CpnReconcileResult = {
  paymentId: string;
  from: string;
  to: string;
  action: CpnReconcileAction;
  detail?: string;
};

/**
 * Reconcile one stored cash-out against the rail.
 *
 * A read failure is reported, never thrown: one unreachable payment must not
 * abandon the rest of the sweep, and a row left alone is exactly as correct as
 * it was before — still stale, still owed a later pass.
 */
export async function reconcileCpnPayment(
  deps: { store: CpnReconcileStore; ramp: CpnStatusReader },
  record: CpnPaymentRecord,
): Promise<CpnReconcileResult> {
  const base = { paymentId: record.payment_id, from: record.status, to: record.status };

  if (isPaymentTerminal(record.status)) {
    return { ...base, action: "ignored", detail: "already terminal" };
  }

  let polled: string;
  try {
    polled = (await deps.ramp.status(record.payment_id)).status;
  } catch (e) {
    return {
      ...base,
      action: "unreachable",
      detail: String((e as Error)?.message ?? e).slice(0, 200),
    };
  }

  const outcome = reconcilePaymentStatus(record.status, polled);
  if (!outcome.changed) {
    // Agreement needs no explanation; anything else does. The property is
    // omitted rather than set to undefined — `exactOptionalPropertyTypes` draws
    // that distinction and it is the right one here.
    if (outcome.reason === "duplicate") return { ...base, action: "unchanged" };
    return {
      ...base,
      action: "ignored",
      detail: `rail reported ${polled} (${outcome.reason})`,
    };
  }

  await deps.store.advanceCpnPayment(record.payment_id, outcome.state);
  // Recorded like a webhook would be, but explicitly NOT signature-verified:
  // this state came from a poll we made, not from a message Circle signed. A
  // row that claims verification it never had is worse than an unverified one.
  await deps.store.recordEvent({
    type: "cpn.reconcile.advanced",
    payload: { paymentId: record.payment_id, from: record.status, to: outcome.state, polled },
    sigVerified: false,
  });

  return { ...base, to: outcome.state, action: "advanced" };
}

/**
 * Sweep every non-terminal cash-out.
 *
 * `limit` bounds the read, not the repair — rows beyond it are simply not seen
 * this pass, and the next one starts from the same end of the list. The cap
 * exists because this costs one API call per row against a rate-limited rail.
 */
export async function reconcileCpnPayments(
  deps: { store: CpnReconcileStore; ramp: CpnStatusReader },
  opts: { limit?: number } = {},
): Promise<CpnReconcileResult[]> {
  const rows = await deps.store.listCpnPayments(opts.limit ?? 100);
  const out: CpnReconcileResult[] = [];
  for (const row of rows) {
    if (isPaymentTerminal(row.status)) continue;
    out.push(await reconcileCpnPayment(deps, row));
  }
  return out;
}
