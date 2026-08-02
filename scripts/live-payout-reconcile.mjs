/**
 * Reconcile broadcast payouts against the rail.
 *
 * A payout's ledger row is written `pending` at broadcast, because that is the
 * truth then: the transfer has not been mined and has no hash. The hash appears
 * on a later read. Any run that ends in between — a script that exits, a
 * process that restarts, a webhook that never arrives — leaves a `pending` row
 * on an order that has since been paid.
 *
 * This is the sweep that closes that gap. It drives `kit.refreshPayout`, which
 * is the same path a webhook would take, so nothing here writes state that the
 * normal flow could not have written itself. Read-only against the chain; the
 * only writes are to the order's own record.
 *
 *   node scripts/live-payout-reconcile.mjs            # every unsettled payout
 *   node scripts/live-payout-reconcile.mjs ord_123    # one order
 */
import { getAddress } from "viem";
import { createPublicClient } from "viem";
import { arcTestnet } from "viem/chains";
import { arcTransport } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from "../src/constants/arc.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { createRivoKit } from "../src/sdk/rivokit.ts";
import { createCpnRamp } from "../src/ramp/cpn-ramp.ts";
import { createCpnPayoutRail } from "../src/payout/cpn-payout.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();
const env = readEnv();

const store = createOrderStore(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
const arcClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });

const ramp = createCpnRamp({
  apiKey: env.CIRCLE_CPN_KEY,
  corridor: {
    senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US",
    destinationCountry: "FR", blockchain: "ARC-TESTNET", paymentMethodType: "SEPA",
    sourceCurrency: "USDC", destinationCurrency: "EUR",
  },
});

/**
 * Reconciliation only ever READS the rail, so the parts of a rail that move
 * money are stubbed to throw rather than left plausible. A sweep that could
 * broadcast a payment by accident would be a much worse bug than a stale row.
 */
const refuse = (what) => () => {
  throw new Error(`live-payout-reconcile: refusing to ${what} — this sweep only reads.`);
};

const payoutRail = createCpnPayoutRail({
  ramp,
  corridor: "EUR-SEPA",
  destinationCountry: "FR",
  senderAddress: "0x0000000000000000000000000000000000000000",
  details: refuse("resolve beneficiary details"),
  signIntent: refuse("sign a payment intent"),
});

const kit = createRivoKit({
  store,
  escrow: createEscrow({
    escrowAddress: getAddress(env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS),
    publicClient: arcClient,
    operator: refuse("send an escrow transaction"),
  }),
  fx: { quote: refuse("quote"), lockQuote: refuse("lock a quote"), swapWithFloor: refuse("swap") },
  bridge: { execute: refuse("bridge") },
  fund: refuse("fund"),
  payoutRail,
  config: {
    chainId: ARC_TESTNET_CHAIN_ID,
    escrowAddress: getAddress(env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS),
    operator: getAddress(env.OPERATOR_ADDRESS),
    token: USDC_ADDRESS,
    refundCollector: getAddress(env.NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS),
    settlementAddress: getAddress(env.MERCHANT_ADDRESS),
  },
});

const only = process.argv[2];
const orders = only
  ? [await store.get(only)].filter(Boolean)
  : (await store.listOrders(200)).filter((o) => o.state === "payout_pending" || o.state === "paid_out");

if (!orders.length) {
  console.log("No broadcast payouts to reconcile.");
  process.exit(0);
}

let repaired = 0;
for (const order of orders) {
  const before = (await store.listPayments(order.id)).find((p) => p.kind === "payout");
  if (!before) continue;

  const payout = await kit.refreshPayout(order.id);
  const after = (await store.listPayments(order.id)).find((p) => p.kind === "payout");
  const fresh = await store.get(order.id);

  const changed = before.status !== after?.status || before.tx_hash !== after?.tx_hash;
  if (changed) repaired += 1;

  console.log(
    `${changed ? "REPAIRED" : "  ok    "}  ${order.id}  ${order.state} → ${fresh.state}` +
      `  · ledger ${before.status} → ${after?.status}` +
      `  · CPN ${payout?.reference?.status}` +
      `${after?.tx_hash ? `  · tx ${after.tx_hash}` : "  · no tx hash yet"}`,
  );
}

console.log(`\n${repaired}/${orders.length} rows repaired.`);
