/**
 * Reconcile standalone cash-outs against CPN.
 *
 * The sibling of `live-payout-reconcile.mjs`, for the rows that script cannot
 * reach. A payout attached to an ORDER is repaired through `kit.refreshPayout`.
 * A standalone cash-out has no order, so nothing walks it: it is written to
 * `cpn_payments` at broadcast and from then on only a webhook moves it. When the
 * endpoint is down — and the one this repo proved against was a quick tunnel
 * that dies with its own process — the row stays `CRYPTO_FUNDS_PENDING` forever
 * while the money has long since arrived or failed.
 *
 * READ-ONLY against the rail. The only writes are the stored status and an
 * audit event, and both go through `reconcilePaymentStatus`, which moves
 * forward only and never leaves a terminal state. Running it twice is a no-op.
 *
 *   node scripts/live-cashout-reconcile.mjs           # every non-terminal row
 *   node scripts/live-cashout-reconcile.mjs pay_123   # one payment
 */
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { createCpnRamp } from "../src/ramp/cpn-ramp.ts";
import { reconcileCpnPayment, reconcileCpnPayments } from "../src/ramp/cpn-reconcile.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();
const env = readEnv();

const store = createOrderStore(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);

/**
 * The corridor is only here because `createCpnRamp` asks for one — this sweep
 * calls `status()` and nothing else, and reading a payment by id does not
 * depend on the corridor it was created in.
 */
const ramp = createCpnRamp({
  apiKey: env.CIRCLE_CPN_KEY,
  corridor: {
    senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US",
    destinationCountry: "FR", blockchain: "ARC-TESTNET", paymentMethodType: "SEPA",
    sourceCurrency: "USDC", destinationCurrency: "EUR",
  },
});

const only = process.argv[2];

let results;
if (only) {
  const row = await store.getCpnPayment(only);
  if (!row) {
    console.error(`No cash-out stored under ${only}.`);
    process.exit(1);
  }
  results = [await reconcileCpnPayment({ store, ramp }, row)];
} else {
  results = await reconcileCpnPayments({ store, ramp }, { limit: 200 });
}

if (!results.length) {
  console.log("No non-terminal cash-outs to reconcile.");
  process.exit(0);
}

const MARK = {
  advanced: "REPAIRED",
  unchanged: "  ok    ",
  ignored: "  skip  ",
  unreachable: "  FAIL  ",
};

for (const r of results) {
  const move = r.action === "advanced" ? `${r.from} → ${r.to}` : r.from;
  console.log(`${MARK[r.action]}  ${r.paymentId}  ${move}${r.detail ? `  · ${r.detail}` : ""}`);
}

const repaired = results.filter((r) => r.action === "advanced").length;
const unreachable = results.filter((r) => r.action === "unreachable").length;

console.log(`\n${repaired}/${results.length} rows repaired.`);
if (unreachable > 0) {
  // Said plainly rather than folded into the count: an unreachable row is still
  // stale, and reporting the sweep as clean would be the thing this exists to
  // prevent.
  console.log(`${unreachable} could not be read and remain stale — run again.`);
}
