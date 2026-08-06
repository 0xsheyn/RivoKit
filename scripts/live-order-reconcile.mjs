/**
 * Reconcile pending ORDERS against the escrow — the third sweep, and the one
 * that had no runner.
 *
 * Two already exist and both have one: `live-payout-reconcile.mjs` repairs a
 * payout's ledger row, `live-cashout-reconcile.mjs` repairs a `cpn_payments`
 * row. `reconcilePending` covers the gap neither touches — an ORDER whose
 * funding move started and whose result was never written back — and it has
 * been exported from the SDK with nothing calling it. An order stuck in
 * `funding_pending` because a process died between the burn and the state write
 * is invisible to every other sweep in this repo.
 *
 * WHAT IT CAN AND CANNOT CLOSE. The two pending states are not symmetric, and
 * the asymmetry is the whole design (see src/orchestrator/reconcile.ts):
 *
 *   funding_pending — fully re-derivable. Ask the escrow whether it holds the
 *                     authorized amount. If it does, the order is funded and
 *                     this promotes it.
 *
 *   refund_pending  — NOT re-derivable. The escrow was already returned to the
 *                     payer; what may still be outstanding is the bridge back
 *                     to `receivingChain`, and escrow state says nothing about
 *                     that leg. Such an order is REPORTED, never closed —
 *                     marking it `refunded` on escrow evidence alone would
 *                     claim the payer has their money on the origin chain when
 *                     they might not.
 *
 * READ-ONLY against the chain. The escrow handle is built with a sender that
 * throws: this sweep calls `paymentState` and nothing else, and a sender that
 * cannot send is how that is enforced rather than merely intended. The only
 * writes are checked state transitions on the order's own record, so running it
 * twice writes nothing the first run did not.
 *
 *   node scripts/live-order-reconcile.mjs            # every pending order
 *   node scripts/live-order-reconcile.mjs ord_123    # one order
 */
import { createPublicClient, getAddress } from "viem";
import { arcTestnet } from "viem/chains";
import { arcTransport } from "../src/lib/rpc.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { reconcileOrder, reconcilePending } from "../src/orchestrator/reconcile.ts";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();

const store = createOrderStore(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);

const escrow = createEscrow({
  escrowAddress: getAddress(env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS),
  publicClient: createPublicClient({ chain: arcTestnet, transport: arcTransport() }),
  // Deliberately unable to send. `reconcileOrder` reads `paymentState` and
  // never writes on-chain; if that ever changes, this line is what will say so
  // — loudly, at the moment it happens, instead of quietly broadcasting from a
  // sweep nobody expects to move funds.
  operator: () => {
    throw new Error(
      "live-order-reconcile is read-only against the chain — it must never send a transaction.",
    );
  },
});

const MARK = {
  advanced_to_funded: "REPAIRED",
  still_funding: "  wait  ",
  needs_bridge_retry: "  OWED  ",
  blocked_no_hash: "  FAIL  ",
  skipped: "  skip  ",
};

// No `process.exit()` on any path that has already talked to Supabase. The
// client keeps a live socket, and tearing the loop down under it aborts on
// Windows with a libuv assertion — which reads as a crash in a sweep that in
// fact did its whole job. `exitCode` lets the process end when it is ready.
const only = process.argv[2];
const order = only ? await store.get(only) : null;

if (only && !order) {
  console.error(`No order stored under ${only}.`);
  process.exitCode = 1;
} else {
  const results = order
    ? [await reconcileOrder({ store, escrow }, order)]
    : await reconcilePending({ store, escrow });

  if (!results.length) {
    console.log("No pending orders to reconcile.");
  } else {
    for (const r of results) {
      const move = r.action === "advanced_to_funded" ? `${r.from} → funded` : r.from;
      console.log(`${MARK[r.action] ?? "  ?     "}  ${r.orderId}  ${move}${r.detail ? `  · ${r.detail}` : ""}`);
    }

    const repaired = results.filter((r) => r.action === "advanced_to_funded").length;
    const owed = results.filter((r) => r.action === "needs_bridge_retry").length;
    const blocked = results.filter((r) => r.action === "blocked_no_hash").length;

    console.log(`\n${repaired}/${results.length} orders repaired.`);

    // Said separately rather than folded into the count, because neither is a
    // success and neither is a failure of this sweep.
    if (owed > 0) {
      console.log(
        `${owed} in refund_pending still owe their origin-chain leg — that needs the payer's own adapters ` +
          "(scripts/live-refund.mjs finishes the bridge without voiding twice).",
      );
    }
    if (blocked > 0) {
      console.log(
        `${blocked} could not be checked: no payment_info_hash stored, so there is nothing to ask the escrow about.`,
      );
    }
  }
}
