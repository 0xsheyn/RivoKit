/**
 * The claim this repo could not yet make: escrow → BANK, in one call.
 *
 * Everything runs through the RivoKit facade. `kit.release()` captures from the
 * escrow and then drives the CPN off-ramp itself — there is no second script,
 * no manual hand-off, and no MOCK payout at the end. What proves it is not the
 * console output but the stored record: `payoutFor()` returns a payout labelled
 * LIVE with a CPN payment id anyone can query, and the order reaches
 * `payout_pending` and then `paid_out`.
 *
 * WHY THE SELLER IS AN EOA HERE
 *
 * The settlement wallet has to do three things on this path: receive the
 * capture, approve Permit2, and sign the payment intent. The demo's seller key
 * (SELLER_PRIVATE_KEY) can do all three, so it stands in as receiver AND
 * settlement address. In production the seller signs in their own wallet —
 * `signIntent` is injected precisely so no key has to live near the CPN key.
 *
 * IRREVERSIBLE. `kit.release()` broadcasts a real CPN payment; past
 * BROADCASTED the USDC is gone. The script therefore stops and asks before the
 * release step, and will not proceed without an explicit --yes.
 *
 *   node scripts/live-sdk-bank.mjs               # dry run: sizes and prices, stops before release
 *   node scripts/live-sdk-bank.mjs --yes         # actually broadcasts
 *   node scripts/live-sdk-bank.mjs --yes --reset # start a fresh order
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AppKit } from "@circle-fin/app-kit";
import {
  createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { createCircleClient } from "./lib/circle.mjs";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, EURC_ADDRESS, PERMIT2_ADDRESS, USDC_ADDRESS } from "../src/constants/arc.ts";
import { receiveAuthorizationTypedData } from "../src/escrow/erc3009.ts";
import { ESCROW_SIGNATURES } from "../src/escrow/abi.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createSettlementFx } from "../src/settlement-fx/swap.ts";
import { createBridge } from "../src/funding/bridge.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { createComplianceGate, createCircleScreener } from "../src/events/compliance.ts";
import { createRivoKit } from "../src/sdk/rivokit.ts";
import { createCpnRamp } from "../src/ramp/cpn-ramp.ts";
import { createCpnPayoutRail } from "../src/payout/cpn-payout.ts";
import { normalizeTypedData } from "../src/ramp/cpn-sign.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();

const STATE_FILE = ".live-sdk-bank.json";

// €10.00 guaranteed to the seller. Above the corridor's 9 EUR fiat minimum with
// room to spare, and the USDC it costs (~11.6) clears the 11 USDC crypto
// minimum — both limits read live from the route, not assumed.
const PRICE_EUR = parseUnits("10", 6);
// Wider than the wallet path's 150 bps on purpose: this buffer has to absorb
// CPN's spread AND its fees between sizing and release, not a swap's slippage.
const BUFFER_BPS = 400;

const CONFIRMED = process.argv.includes("--yes");

const env = readEnv();

const ESCROW = getAddress(env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS);
const TOKEN_COLLECTOR = getAddress(env.NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS);
const REFUND_COLLECTOR = getAddress(env.NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS);
const OPERATOR = getAddress(env.OPERATOR_ADDRESS);

const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
/** The seller: receives the capture, approves Permit2, signs the CPN intent. */
const seller = privateKeyToAccount(env.SELLER_PRIVATE_KEY);

const arcClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const buyerWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: arcTransport() });
const sellerWallet = createWalletClient({ account: seller, chain: arcTestnet, transport: arcTransport() });
const circle = createCircleClient({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET });
const store = createOrderStore(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const fmt = (v) => formatUnits(BigInt(v ?? 0), 6);
const fmt2 = (v) => (Number(BigInt(v ?? 0)) / 100).toFixed(2);
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
};

if (process.argv.includes("--reset") && existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ── Escrow, driven by the operator's Circle wallet ─────────────────────

const toTuple = (pi) => [
  pi.operator, pi.payer, pi.receiver, pi.token, pi.maxAmount.toString(),
  String(pi.preApprovalExpiry), String(pi.authorizationExpiry), String(pi.refundExpiry),
  String(pi.minFeeBps), String(pi.maxFeeBps), pi.feeReceiver, pi.salt.toString(),
];

const operatorSender = async ({ functionName, args }) => {
  const tx = await circle.contractExecution({
    walletId: env.OPERATOR_WALLET_ID,
    contractAddress: ESCROW,
    abiFunctionSignature: ESCROW_SIGNATURES[functionName],
    abiParameters: args.map((a) =>
      a && typeof a === "object" && "operator" in a ? toTuple(a) : typeof a === "bigint" ? a.toString() : a,
    ),
  });
  info(`${functionName}: id ${tx.id}`);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const t = await circle.getTransaction(tx.id);
    const s = t.transaction?.state;
    if (["COMPLETE", "CONFIRMED"].includes(s)) return { txHash: t.transaction.txHash };
    if (["FAILED", "CANCELLED", "DENIED"].includes(s)) {
      throw new Error(`${functionName} ${s}: ${t.transaction?.errorReason ?? "no reason given"}`);
    }
  }
  throw new Error(`${functionName}: timeout`);
};

const escrow = createEscrow({ escrowAddress: ESCROW, publicClient: arcClient, operator: operatorSender });
const fx = createSettlementFx({
  kitKey: env.KIT_KEY, circleApiKey: env.CIRCLE_API_KEY, circleEntitySecret: env.CIRCLE_ENTITY_SECRET,
});
const bridge = createBridge(new AppKit());
const gate = createComplianceGate(
  createCircleScreener((path, body) => circle.request("POST", path, body), () => randomUUID()),
);

// ── The payout rail: CPN, EUR/SEPA, sourced from the seller's Arc USDC ──

if (!env.CIRCLE_CPN_KEY) throw new Error("CIRCLE_CPN_KEY is empty — run: node scripts/sync-env.mjs");

const ramp = createCpnRamp({
  apiKey: env.CIRCLE_CPN_KEY,
  corridor: {
    senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US",
    destinationCountry: "FR", blockchain: "ARC-TESTNET", paymentMethodType: "SEPA",
    sourceCurrency: "USDC", destinationCurrency: "EUR",
  },
});

// Beneficiary + travel-rule fields, read live from the corridor's requirements
// endpoint during earlier probes. Demo values: a testnet IBAN, not a real one.
const FR_ADDRESS = { street: "1 Rue de Rivoli", city: "Paris", stateProvince: "IDF", country: "FR", postalCode: "75001" };
const US_ADDRESS = { street: "456 Madison Ave", city: "New York", stateProvince: "NY", country: "US", postalCode: "10001" };

/**
 * Ensure Permit2 can pull `amountMinor` from the SELLER. Runs in the rail's
 * `ready()` — before any quote exists — so an approval transaction can never
 * eat the 30-60 seconds a CPN quote lives for.
 */
const ensureAllowance = async (amountMinor) => {
  const allowance = await arcClient.readContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [seller.address, PERMIT2_ADDRESS],
  });
  if (allowance >= amountMinor) {
    info(`Permit2 allowance already ${fmt(allowance)} USDC — no approval needed`);
    return;
  }
  const hash = await sellerWallet.writeContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, amountMinor],
  });
  await arcClient.waitForTransactionReceipt({ hash });
  state.approveTxHash = hash;
  save();
  info(`Permit2 approved for ${fmt(amountMinor)} USDC — tx ${hash}`);
};

const payoutRail = createCpnPayoutRail({
  ramp,
  corridor: "EUR-SEPA",
  destinationCountry: "FR",
  senderAddress: seller.address,
  details: () => ({
    travelRule: [
      { name: "ORIGINATOR_NAME", value: "Rivo Co" },
      { name: "BENEFICIARY_NAME", value: "Acme Co" },
      { name: "ORIGINATOR_ADDRESS", value: US_ADDRESS },
      { name: "BENEFICIARY_ADDRESS", value: FR_ADDRESS },
      { name: "ORIGINATOR_ACCOUNT_NUMBER", value: "US1234567890" },
      { name: "ORIGINATOR_FINANCIAL_INSTITUTION_NAME", value: "Rivo Bank" },
      { name: "ORIGINATOR_FINANCIAL_INSTITUTION_ADDRESS", value: US_ADDRESS },
    ],
    beneficiaryAccount: [
      { name: "IBAN", value: "FR7630006000011234567890189" },
      { name: "RECIPIENT_LEGAL_NAME", value: "Acme SARL" },
    ],
    useCase: "B2B",
    reasonForPayment: "PMT001",
  }),
  // The wallet that HOLDS the USDC is the wallet that authorizes it to leave.
  // The CPN key never touches this function.
  signIntent: (message) => sellerWallet.signTypedData(normalizeTypedData(message)),
  ensureAllowance,
});

// ── Funding: same-chain ERC-3009, so the proof does not wait on a bridge ──

const fundExecutor = async ({ paymentInfo, hash }) => {
  const ps = await escrow.getPaymentState(hash);
  if (ps.hasCollectedPayment) {
    info("escrow already holds the payment — skipping authorize (idempotent)");
    // A real hash when this run produced one; otherwise none at all. The
    // facade skips the ledger write rather than recording a placeholder that
    // no explorer can resolve.
    return state.authorizeTxHash ? { authorizeTxHash: state.authorizeTxHash } : {};
  }
  if (!state.signature) {
    state.signature = await buyerWallet.signTypedData(
      receiveAuthorizationTypedData({
        paymentInfo, chainId: ARC_TESTNET_CHAIN_ID, escrowAddress: ESCROW,
        tokenCollector: TOKEN_COLLECTOR, usdcAddress: USDC_ADDRESS,
      }),
    );
    save();
  }
  const auth = await escrow.authorize(paymentInfo, paymentInfo.maxAmount, TOKEN_COLLECTOR, state.signature);
  state.authorizeTxHash = auth.txHash;
  save();
  return { authorizeTxHash: auth.txHash };
};

/**
 * Return the payer's surplus — the buffer they overpaid that the payout quote
 * did not need.
 *
 * `token` is read, not assumed. On the wallet path the surplus is EURC (what
 * the swap produced); here no swap ran, so it is USDC. Hardcoding either would
 * send an asset the settlement wallet does not hold from this order — which is
 * exactly why the token travels with the amount.
 */
const payRebate = async ({ to, amountMinor, token }) => {
  const address = token === "EURC" ? EURC_ADDRESS : USDC_ADDRESS;
  const hash = await sellerWallet.writeContract({
    address, abi: erc20Abi, functionName: "transfer", args: [to, amountMinor],
  });
  await arcClient.waitForTransactionReceipt({ hash });
  info(`rebate ${fmt(amountMinor)} ${token} → ${to} — tx ${hash}`);
  return { txHash: hash };
};

const kit = createRivoKit({
  store, escrow, fx, bridge, fund: fundExecutor, compliance: gate, payoutRail, payRebate,
  config: {
    chainId: ARC_TESTNET_CHAIN_ID, escrowAddress: ESCROW, operator: OPERATOR, token: USDC_ADDRESS,
    refundCollector: REFUND_COLLECTOR,
    // The seller settles AND signs: capture lands here, and this is the address
    // Permit2 pulls from.
    settlementAddress: seller.address,
    screeningChain: env.CIRCLE_BLOCKCHAIN || "ARC-TESTNET",
  },
});

const events = [];
/** The payout_pending payload — it carries what the rebate leg actually did. */
let rebateSeen = null;
for (const e of ["funding_pending", "funded", "payout_pending", "paid_out", "released", "failed"]) {
  kit.on(e, (p) => {
    events.push(e);
    if (e === "payout_pending") rebateSeen = p;
    info(`[event ${e}] ${json(p)}`);
  });
}

const usdcOf = async (address) => {
  await sleep(250);
  return arcClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });
};

// ── 0. What the corridor will actually take ────────────────────────────

step("Step 0 — the corridor, read live (no constants)");
const limits = await payoutRail.limits();
info(
  `EUR-SEPA on ARC-TESTNET: ${fmt(limits.minSourceMinor)}–${fmt(limits.maxSourceMinor)} ${limits.sourceCurrency}` +
    ` → ${limits.destinationCurrency} (scale ${limits.destinationScale})`,
);
record(limits.sourceCurrency === "USDC", "the rail sources USDC — EURC is not an off-ramp currency");

// ── 1. createOrder, sized from the PAYOUT rail ─────────────────────────

step("Step 1 — kit.createOrder({ payoutTo: 'bank' })");
const sellerBefore = await usdcOf(seller.address);
const buyerBefore = await usdcOf(buyer.address);
info(`seller ${seller.address} holds ${fmt(sellerBefore)} USDC · floor €${fmt(PRICE_EUR)}`);
info(`buyer  ${buyer.address} holds ${fmt(buyerBefore)} USDC`);

let order;
if (state.orderId) {
  order = await kit.status(state.orderId);
  ok(`continuing order ${order.id} — state ${order.state}`);
} else {
  order = await kit.createOrder({
    payer: buyer.address, receiver: seller.address, priceEURMinor: PRICE_EUR,
    receivingChain: "Arc_Testnet", wedge: "digital_goods",
    payoutTo: "bank", bufferBps: BUFFER_BPS,
  });
  state.orderId = order.id;
  save();
  ok(`order ${order.id} — buyer authorizes ${fmt(order.usdcAmount)} USDC, state ${order.state}`);
}
record(order.payoutTo === "bank", "the order is bank-bound");
record(BigInt(order.usdcAmount) >= limits.minSourceMinor, "sized above the corridor minimum", `${fmt(order.usdcAmount)} USDC`);

// ── 2. fund ────────────────────────────────────────────────────────────

step("Step 2 — kit.fund (ERC-3009 authorize into escrow)");
if (order.state === "created") await kit.fund(order.id);
order = await kit.status(order.id);
ok(`state ${order.state}`);
record(order.state === "funded", "funded through the SDK");

// ── 3. release → capture + off-ramp. IRREVERSIBLE. ─────────────────────

step("Step 3 — kit.release (capture → CPN EUR/SEPA). IRREVERSIBLE");

if (order.state === "funded" || order.state === "shipped") {
  if (!CONFIRMED) {
    console.log(
      `\n  STOP. The next call captures ${fmt(order.usdcAmount)} USDC from escrow and BROADCASTS a CPN\n` +
        `  payment for €${fmt(PRICE_EUR)} to the demo IBAN. Once broadcast it cannot be recalled.\n\n` +
        `  Re-run with --yes to proceed:  node scripts/live-sdk-bank.mjs --yes\n`,
    );
    process.exit(0);
  }
  await kit.release(order.id, { kind: "access_granted", ref: "demo-license-key" });
}

order = await kit.status(order.id);
ok(`state ${order.state}`);

let payout = await kit.payoutFor(order.id);
console.log(json(payout));

if (order.state !== "payout_pending" && order.state !== "paid_out") {
  record(false, "release drove the off-ramp", `stopped at ${order.state}`);
  const failed = checks.filter((c) => !c).length;
  step("Result");
  info("Nothing was broadcast. The capture may already have happened — check the order's failure_reason.");
  process.exit(failed ? 1 : 0);
}

record(true, "release() drove the off-ramp itself — no separate cash-out step");
record(payout?.label === "LIVE" && payout?.kind === "cpn", "the payout is LIVE, not MOCK");
record(Boolean(payout?.reference?.paymentId), "the payout carries a CPN payment id", payout?.reference?.paymentId);
record(payout?.executed === true, "the payout is marked broadcast");
record(
  BigInt(payout?.target?.amountMinor ?? 0) >= PRICE_EUR / 10_000n,
  "the floor is met in fiat",
  `€${fmt2(payout?.target?.amountMinor)} vs floor €${fmt(PRICE_EUR)}`,
);

// ── 4. follow the fiat leg to terminal ─────────────────────────────────

step("Step 4 — kit.refreshPayout until the fiat leg is terminal");
info("SEPA runs minutes behind; polling here stands in for the webhook.");

for (let i = 0; i < 40 && order.state === "payout_pending"; i++) {
  await sleep(15_000);
  payout = await kit.refreshPayout(order.id);
  order = await kit.status(order.id);
  info(`[${i + 1}] CPN ${payout?.reference?.status} · order ${order.state}`);
}

record(order.state === "paid_out", "the order reached paid_out", `CPN ${payout?.reference?.status}`);

const sellerAfter = await usdcOf(seller.address);
info(`seller USDC ${fmt(sellerBefore)} → ${fmt(sellerAfter)}`);

// ── 5. the rebate, checked against the chain ───────────────────────────

step("Step 5 — the payer's surplus went back to the payer");
const rebateEvent = rebateSeen;
const buyerAfter = await usdcOf(buyer.address);
const buyerDelta = buyerAfter - buyerBefore;
info(`buyer USDC ${fmt(buyerBefore)} → ${fmt(buyerAfter)} (${buyerDelta >= 0n ? "+" : ""}${fmt(buyerDelta)})`);
record(rebateEvent?.rebateMinor > 0n, "a surplus was owed", `${fmt(rebateEvent?.rebateMinor)} USDC`);
record(Boolean(rebateEvent?.rebateTxHash), "the rebate was delivered, not just computed", rebateEvent?.rebateTxHash);
// The balance is the proof; the event is only a claim about it.
record(
  buyerDelta === (rebateEvent?.rebateMinor ?? 0n),
  "the buyer's on-chain balance rose by exactly the surplus",
  `${fmt(buyerDelta)} vs ${fmt(rebateEvent?.rebateMinor)}`,
);

// ── Result ─────────────────────────────────────────────────────────────

step("Result");
info(`event order: ${events.join(" → ")}`);
info(`order ${order.id} · CPN payment ${payout?.reference?.paymentId}`);
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : " escrow → bank PROVEN end-to-end through release() alone."),
);
process.exit(failed ? 1 : 0);
