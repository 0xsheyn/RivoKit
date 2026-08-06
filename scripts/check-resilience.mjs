/**
 * Which failure scenarios can be exercised RIGHT NOW, and with which order.
 *
 * The resilience paths are the ones worth rehearsing and the hardest to reach
 * on demand: an order only sits in `settlement_pending` if a settlement
 * actually stalled, and a `payout_pending` order only exists in the minutes
 * between a broadcast and the network reporting back. So the honest way to
 * rehearse them is not to force one into existence — it is to know, at a
 * glance, which ones the current data already gives you and which are a click
 * away.
 *
 * That is all this does. It reads the store and the catalog, decides which of
 * the documented failure paths is REACHABLE, and names the order id to use.
 * Every row also names the tool that closes that path, so the checklist doubles
 * as the runbook.
 *
 * READ-ONLY. It never writes and never signs; the only network calls beyond
 * Supabase are the FX quotes in the last section, and those are estimates.
 *
 *   node scripts/check-resilience.mjs
 */
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { createSettlementFx } from "../src/settlement-fx/swap.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { isPaymentTerminal } from "../src/ramp/cpn-state.ts";
import { CATALOG, canPayoutToBank, fmtEUR } from "../demo/lib/catalog.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();
const env = readEnv();

const store = createOrderStore(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);

// Deep enough to see the whole demo history without paging. The board itself
// only ever shows thirty.
const orders = await store.listOrders(80);
const ids = orders.map((o) => o.id);
const [payments, cashouts] = await Promise.all([
  store.listPaymentsFor(ids),
  store.listCpnPayments(100).catch(() => []),
]);

const inState = (...states) => orders.filter((o) => states.includes(o.state));
const hasFunding = (id) => (payments[id] ?? []).some((p) => p.kind === "funding");
const short = (list, n = 3) =>
  list.slice(0, n).map((o) => o.id).join(", ") + (list.length > n ? `, +${list.length - n} more` : "");

/**
 * One row of the checklist.
 *
 * `ready` is the only thing that varies, and it is deliberately not a pass/fail:
 * nothing here is broken when a scenario is unreachable — it just means the data
 * does not currently contain one. `how` therefore always prints, because the
 * unreachable rows are exactly the ones you need instructions for.
 */
function row(ready, name, detail, how) {
  console.log(`  ${ready ? "READY" : "  —  "}  ${name.padEnd(30)} ${detail}`);
  console.log(`         ${" ".repeat(30)} ${how}`);
}

console.log(`Resilience scenarios · ${orders.length} orders in store\n`);

console.log("── Refund ─────────────────────────────────────────────────────────\n");

const voidable = inState("funded", "shipped");
row(
  voidable.length > 0,
  "Refund pre-capture (void)",
  voidable.length ? short(voidable) : "no funded order",
  "Buyer → Raise dispute · Host → Approve refund. Escrow returns the USDC; cheap path.",
);

const postCapture = inState("released");
row(
  postCapture.length > 0,
  "Refund post-capture",
  postCapture.length ? short(postCapture) : "no released order",
  "/sdk → Refund. Pulls from the OPERATOR's balance, not escrow — far costlier. No button in /app.",
);

const refunding = inState("refund_pending");
row(
  refunding.length > 0,
  "Bridge-back leg outstanding",
  refunding.length ? short(refunding) : "none",
  "node scripts/live-refund.mjs — finishes the origin-chain leg without voiding twice.",
);

console.log("\n── Settlement ─────────────────────────────────────────────────────\n");

const stalled = inState("settlement_pending");
row(
  stalled.length > 0,
  "Settlement stalled → retry",
  stalled.length ? short(stalled) : "none",
  "Host panel → Retry settlement. To CREATE one: node scripts/live-recovery.mjs",
);
// The reason is the whole value of this state — a stall worth retrying now and
// one worth retrying tomorrow look identical without it.
for (const o of stalled.slice(0, 3)) {
  console.log(`         ${" ".repeat(30)} · ${o.id}: ${(o.failure_reason ?? "no reason recorded").slice(0, 96)}`);
}

console.log("\n── Funding ────────────────────────────────────────────────────────\n");

const pending = inState("funding_pending");
const landed = pending.filter((o) => hasFunding(o.id));
const nothingLanded = pending.filter((o) => !hasFunding(o.id));
row(
  landed.length > 0,
  "Authorization missing",
  landed.length ? short(landed) : "none",
  "USDC reached Arc, ERC-3009 never signed → Finish payment. Re-signing is idempotent.",
);
row(
  nothingLanded.length > 0,
  "Funding never completed",
  nothingLanded.length ? short(nothingLanded) : "none",
  "Marked paying with no funding row. node scripts/live-order-reconcile.mjs re-derives it from escrow.",
);

const now = Date.now();
const created = inState("created");
const expired = created.filter((o) => Date.parse(o.pre_approval_expiry) <= now);
const live = created.filter((o) => Date.parse(o.pre_approval_expiry) > now);
row(
  expired.length > 0,
  "Authorization window closed",
  expired.length ? short(expired) : "none",
  // Three different instructions, because "ready", "one command away" and
  // "nothing to work with" are three different situations and a single line
  // for all of them is right for at most one.
  expired.length
    ? "Close order — the escrow already refuses to collect, so nothing else is offered."
    : live.length
      ? `Reach it without waiting an hour: node scripts/demo-expire.mjs ${live[0].id}`
      : "Needs an unpaid order first — buy something, then age it with scripts/demo-expire.mjs.",
);

console.log("\n── Payout & reconciliation ────────────────────────────────────────\n");

const inTransit = inState("payout_pending");
row(
  inTransit.length > 0,
  "Bank payout in transit",
  inTransit.length ? short(inTransit) : "none",
  "Board polls refreshPayout. Manual: node scripts/live-payout-reconcile.mjs",
);

const stalePayoutRows = ids.filter((id) =>
  (payments[id] ?? []).some((p) => p.kind === "payout" && p.status === "pending"),
);
row(
  stalePayoutRows.length > 0,
  "Payout ledger row stale",
  stalePayoutRows.length ? stalePayoutRows.slice(0, 3).join(", ") : "none",
  "A payout row is BORN pending — the Arc hash exists only once mined. node scripts/live-payout-reconcile.mjs",
);

const openCashouts = cashouts.filter((c) => !isPaymentTerminal(c.status));
row(
  openCashouts.length > 0,
  "CPN row non-terminal",
  openCashouts.length ? openCashouts.slice(0, 3).map((c) => `${c.payment_id.slice(0, 8)}…(${c.status})`).join(", ") : "none",
  "node scripts/live-cashout-reconcile.mjs — the only thing that closes a row no webhook reached.",
);

console.log("\n── Which listings can be bought at all ────────────────────────────\n");

/*
 * Not a resilience path, and it is here because it GATES every one of them: the
 * scenarios above all start with buying something, and a wallet listing whose
 * swap size no maker will serve is refused at checkout. Which of the six are
 * currently purchasable is therefore the first thing to know, and it is a live
 * market fact that moves.
 */
const WALLET_BUFFER_BPS = 150n;

try {
  const fx = createSettlementFx({
    kitKey: env.KIT_KEY,
    circleApiKey: env.CIRCLE_API_KEY,
    circleEntitySecret: env.CIRCLE_ENTITY_SECRET,
  });
  const address = env.MERCHANT_ADDRESS;

  // One small probe for the rate — small because a probe at a size the market
  // cannot serve returns no rate for anything — then one quote per wallet
  // listing at the size its own swap would actually be.
  const probe = await fx.quote({ address, tokenIn: "USDC", tokenOut: "EURC", amountInMinor: 5_000_000n });
  const rate = Number(probe.amountOutMinor) / Number(probe.amountInMinor);
  console.log(`  USDC→EURC ${rate.toFixed(6)} at 5 USDC\n`);

  for (const p of CATALOG) {
    if (canPayoutToBank(p)) {
      // No swap runs on the bank path — the corridor's own minimum decides it,
      // and PayoutRail.limits() is the authority. Not re-checked here.
      console.log(`  bank    ${p.name.padEnd(16)} ${fmtEUR(p.priceEURMinor).padStart(7)}  → CPN, no swap`);
      continue;
    }
    const price = BigInt(p.priceEURMinor);
    const net = (price * BigInt(probe.amountInMinor)) / BigInt(probe.amountOutMinor);
    const size = net + (net * WALLET_BUFFER_BPS) / 10_000n;
    try {
      await fx.quote({ address, tokenIn: "USDC", tokenOut: "EURC", amountInMinor: size });
      console.log(`  OK      ${p.name.padEnd(16)} ${fmtEUR(p.priceEURMinor).padStart(7)}  → swap ${(Number(size) / 1e6).toFixed(6)} USDC`);
    } catch (e) {
      console.log(
        `  BLOCKED ${p.name.padEnd(16)} ${fmtEUR(p.priceEURMinor).padStart(7)}  → swap ${(Number(size) / 1e6).toFixed(6)} USDC · ` +
          String(e?.message ?? e).slice(0, 60),
      );
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
} catch (e) {
  // A rate-limited or unreachable quote must not fail a checklist whose real
  // subject is the stored data above.
  console.log(`  (FX unreadable — ${String(e?.message ?? e).slice(0, 90)})`);
}

console.log(
  "\nNothing above was written. Every REPAIR tool named here is idempotent; " +
    "the only irreversible action in this area is a CPN broadcast.",
);
