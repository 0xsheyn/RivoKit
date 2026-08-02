/**
 * The DEMO's own bank payout — driven through its server actions, not the SDK.
 *
 * `scripts/live-sdk-bank.mjs` proves the facade. This proves the thing a user
 * actually touches: `mpCheckout` → `mpPay` → `mpRelease` → `mpRefreshPayout`,
 * exactly the functions the marketplace UI calls. Server actions are plain
 * async functions, so Node can drive them; the "use server" directive is inert
 * outside Next.
 *
 * What it is really checking is the wiring, not the rail: that the demo builds a
 * `payoutRail`, that a bank order is paid to the SELLER rather than the merchant
 * (the off-ramp spends the captured USDC, so it must land where the signer is),
 * and that the rebate goes back as USDC rather than the merchant's EURC.
 *
 * IRREVERSIBLE past release: a real CPN payment is broadcast.
 *
 *   node scripts/live-demo-bank.mjs                    # stops before funding
 *   node scripts/live-demo-bank.mjs --yes
 *   node scripts/live-demo-bank.mjs --yes --order=ord_… # resume an existing one
 */
import { createPublicClient, erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { USDC_ADDRESS } from "../src/constants/arc.ts";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();
const CONFIRMED = process.argv.includes("--yes");
const PRODUCT = process.argv.find((a) => a.startsWith("--product="))?.split("=")[1] ?? "snk";
/** Resume an order that already exists. Funding locks money — never redo it. */
const RESUME = process.argv.find((a) => a.startsWith("--order="))?.split("=")[1];

// Imported after env is loaded: the demo module reads process.env at import.
const { mpCheckout, mpPay, mpRelease, mpRefreshPayout, mpOrderView, mpPayoutOptions } =
  await import("../demo/app/marketplace.actions.ts");
const { productById, canPayoutToBank } = await import("../demo/lib/catalog.ts");

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const fmt = (v) => formatUnits(BigInt(v ?? 0), 6);

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Server actions return {ok, view} | {ok:false, error} — fail loudly, not silently. */
const must = (res, what) => {
  if (!res?.ok) throw new Error(`${what} failed: ${res?.error ?? "unknown"}`);
  return res.view;
};

const arc = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
const seller = privateKeyToAccount(env.RELAYER_PRIVATE_KEY);
const usdcOf = (a) =>
  arc.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [a] });

// ── 0. Can the demo do this at all? ────────────────────────────────────

step("Step 0 — the demo's own payout wiring");
const opts = await mpPayoutOptions();
info(`payout enabled ${opts.enabled} · corridor ${opts.corridor}`);
record(opts.enabled, "the demo built a payoutRail");

const product = productById(PRODUCT);
if (!product) throw new Error(`no such product: ${PRODUCT}`);
info(`${product.emoji} ${product.name} — €${fmt(product.priceEURMinor)}`);
record(canPayoutToBank(product), "the listing clears the corridor minimum", `€${fmt(product.priceEURMinor)}`);

const buyerBefore = await usdcOf(buyer.address);
const sellerBefore = await usdcOf(seller.address);
info(`buyer ${fmt(buyerBefore)} USDC · seller ${fmt(sellerBefore)} USDC`);

// ── 1. Checkout as a bank order ────────────────────────────────────────

step(RESUME ? `Step 1 — resuming ${RESUME}` : 'Step 1 — mpCheckout(product, payer, seller, "bank")');
// The actions already return the full view, so there is nothing to re-fetch.
const created = RESUME
  ? must(await mpOrderView(RESUME), "mpOrderView")
  : must(await mpCheckout(product.id, undefined, undefined, "bank"), "mpCheckout");
const orderId = created.id;
ok(`order ${orderId} — ${fmt(created.usdcAmount)} USDC authorized · state ${created.state}`);
record(created.payoutTo === "bank", "the order is bank-bound", created.payoutTo);
// The off-ramp spends the CAPTURED USDC, so it has to land on the wallet that
// signs the Permit2 intent. Paying the merchant would leave it nothing to pull.
record(
  created.receiver?.toLowerCase() === seller.address.toLowerCase(),
  "a bank order pays the SELLER, not the merchant",
  created.receiver,
);

// The gate sits HERE, before funding — not before release. `mpPay` moves the
// buyer's USDC into escrow, and a "dry run" that quietly locks money is not a
// dry run. It is recoverable by refund, which is exactly why it still deserves
// a stop rather than a shrug.
if (!CONFIRMED) {
  console.log(
    `\n  STOP. Continuing would fund ${fmt(created.usdcAmount)} USDC into escrow, then capture it\n` +
      `  and BROADCAST a real CPN ${opts.corridor} payment for €${fmt(product.priceEURMinor)}.\n` +
      `  The broadcast is not recallable.\n\n` +
      `  node scripts/live-demo-bank.mjs --yes\n`,
  );
  process.exit(0);
}

// ── 2. Pay ─────────────────────────────────────────────────────────────

step("Step 2 — mpPay (same-chain, gasless authorize)");
const funded = created.state === "created" ? must(await mpPay(orderId, "arc"), "mpPay") : created;
ok(`state ${funded.state}`);
record(funded.state === "funded", "funded through the demo action", funded.state);

// ── 3. Release → off-ramp ──────────────────────────────────────────────

step("Step 3 — mpRelease (capture → CPN broadcast). IRREVERSIBLE");
// Snapshot here, not at the top: on a resumed order the funding already
// happened, so a delta measured from the start would read as the buyer LOSING
// money when in fact all that is left to observe is the rebate arriving.
const buyerPreRelease = await usdcOf(buyer.address);
let view = must(await mpRelease(orderId), "mpRelease");
ok(`state ${view.state} · ${view.statusLabel}`);
record(view.state === "payout_pending" || view.state === "paid_out", "release drove the off-ramp", view.state);
record(view.payout?.label === "LIVE", "the demo shows a LIVE payout, not MOCK", view.payout?.label);
record(Boolean(view.payout?.reference?.paymentId), "CPN payment id recorded", view.payout?.reference?.paymentId);

// ── 4. Follow it to terminal ───────────────────────────────────────────

step("Step 4 — mpRefreshPayout until the fiat lands");
for (let i = 0; i < 40 && view.state === "payout_pending"; i++) {
  await sleep(15_000);
  view = must(await mpRefreshPayout(orderId), "mpRefreshPayout");
  info(`[${i + 1}] ${view.state} · ${view.statusLabel}`);
}
record(view.state === "paid_out", "the order reached paid_out", view.statusLabel);

// ── 5. The rebate went back as USDC ────────────────────────────────────

step("Step 5 — the surplus returned to the buyer, in the right token");
const buyerAfter = await usdcOf(buyer.address);
const sellerAfter = await usdcOf(seller.address);
info(`buyer  ${fmt(buyerPreRelease)} → ${fmt(buyerAfter)} across the release`);
info(`seller ${fmt(sellerBefore)} → ${fmt(sellerAfter)}`);

const rebateRow = view.payments?.find((pm) => pm.kind === "rebate");
const rebateDelta = buyerAfter - buyerPreRelease;
record(Boolean(rebateRow?.txHash), "a rebate was delivered, not just computed", rebateRow?.txHash);
// USDC is the point. The wallet path pays the surplus in EURC from the
// merchant; getting that wrong here would move the wrong asset out of the wrong
// wallet and leave this delta at zero.
record(rebateDelta > 0n, "the buyer's USDC balance rose across the release", fmt(rebateDelta));
record(
  view.payout?.sourceCurrency === "USDC",
  "the payout spent USDC, so the surplus is USDC too",
  view.payout?.sourceCurrency,
);

step("Result");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : " The DEMO reaches a bank through its own actions."),
);
process.exit(failed ? 1 : 0);
