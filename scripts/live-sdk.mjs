/**
 * Phase 5 exit criterion — the WHOLE flow runs only through the RivoKit facade.
 *
 * Nothing here calls escrow / swap / funding directly: it constructs `RivoKit`
 * from env and drives createOrder → fund → release → payout purely through
 * `kit.*`, with host handlers wired via `kit.on`. The underlying operations are
 * already proven live per phase; this proves the SDK surface composes them.
 *
 * Funding is injected same-chain (the buyer already holds USDC on Arc), so the
 * proof does not wait minutes on a bridge — the bridge/unified rails have their
 * own live proofs (live-funding.mjs / live-unified.mjs). receivingChain is Arc,
 * so a refund would stay on-chain; the happy path here settles to EURC instead.
 *
 * Needs a StableFX route (createOrder locks a quote, release swaps). If the route
 * is momentarily gone it fails with NO_ROUTE — wait and re-run, do not debug the
 * pair (see stablefx-usdc-eurc-tanpa-rute).
 *
 *   node scripts/live-sdk.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AppKit } from "@circle-fin/app-kit";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { createCircleClient } from "./lib/circle.mjs";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from "../src/constants/arc.ts";
import { getPaymentInfoHash } from "../src/escrow/payment-info.ts";
import { receiveAuthorizationTypedData } from "../src/escrow/erc3009.ts";
import { ESCROW_SIGNATURES } from "../src/escrow/abi.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createSettlementFx } from "../src/settlement-fx/swap.ts";
import { createBridge } from "../src/funding/bridge.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { createComplianceGate, createCircleScreener } from "../src/events/compliance.ts";
import { createRivoKit } from "../src/sdk/rivokit.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";
import { stateFile } from "./lib/state.mjs";

installCircleDnsPinning();

const STATE_FILE = stateFile("live-sdk");
const PRICE_EUR = parseUnits("1.5", 6); // €1.50 guaranteed to the receiver

const env = readEnv();

const ESCROW = getAddress(env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS);
const TOKEN_COLLECTOR = getAddress(env.NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS);
const REFUND_COLLECTOR = getAddress(env.NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS);
const OPERATOR = getAddress(env.OPERATOR_ADDRESS);
const MERCHANT = getAddress(env.MERCHANT_ADDRESS);
const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);

const arcClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const buyerWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: arcTransport() });
const circle = createCircleClient({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET });
const store = createOrderStore(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const fmt = (v) => formatUnits(v, 6);

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
};

if (process.argv.includes("--reset") && existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ── Wire the deps for RivoKit (the ONLY place the modules are touched) ──

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

/**
 * Same-chain FundExecutor: the buyer already holds USDC on Arc, so funding is
 * just an ERC-3009 authorization into escrow. Idempotent — if the escrow already
 * holds the payment (a resumed run), it skips re-authorizing.
 */
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
    // Buyer signs off-chain (no gas); the operator relays the collection.
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

const kit = createRivoKit({
  store, escrow, fx, bridge, fund: fundExecutor, compliance: gate,
  config: {
    chainId: ARC_TESTNET_CHAIN_ID, escrowAddress: ESCROW, operator: OPERATOR, token: USDC_ADDRESS,
    refundCollector: REFUND_COLLECTOR, settlementAddress: MERCHANT, screeningChain: env.CIRCLE_BLOCKCHAIN || "ARC-TESTNET",
  },
});

// ── Host handlers via kit.on (host status stays in sync) ──────────────────────────

const events = [];
for (const e of ["funding_pending", "funded", "released", "refund_pending", "refunded", "failed"]) {
  kit.on(e, (p) => {
    events.push(e);
    info(`[event ${e}] ${JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  });
}

const buyerUsdc = async () => {
  await sleep(250);
  return arcClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] });
};

// ── 1. createOrder ─────────────────────────────────────────────────────

step("Step 1 — kit.createOrder (screening + lock FX + simpan)");

const arcBefore = await buyerUsdc();
info(`buyer Arc ${fmt(arcBefore)} USDC · priceEUR ${fmt(PRICE_EUR)} EURC`);

let order;
if (state.orderId) {
  order = await kit.status(state.orderId);
  ok(`continuing order ${order.id} — state ${order.state}`);
} else {
  order = await kit.createOrder({
    payer: buyer.address, receiver: MERCHANT, priceEURMinor: PRICE_EUR,
    receivingChain: "Arc_Testnet", wedge: "digital_goods",
  });
  state.orderId = order.id;
  save();
  ok(`order ${order.id} — usdcAmount ${fmt(BigInt(order.usdcAmount))} USDC, state ${order.state}`);
}
record(Boolean(order.usdcAmount) && BigInt(order.usdcAmount) > 0n, "createOrder locks usdcAmount through the SDK");
record(order.receivingChain === "Arc_Testnet", "receivingChain recorded");

// ── 2. fund ────────────────────────────────────────────────────────────

step("Step 2 — kit.fund (authorize ke escrow)");

if (order.state === "created") {
  await kit.fund(order.id);
}
order = await kit.status(order.id);
ok(`state ${order.state}`);
record(order.state === "funded", "order funded through the SDK");
record(events.includes("funded"), "the host handler received the funded event");

// ── 3. release ─────────────────────────────────────────────────────────

step("Step 3 — kit.release (capture → floored swap → MOCK payout)");

if (order.state === "funded" || order.state === "shipped") {
  await kit.release(order.id, { kind: "access_granted", ref: "demo-license-key" });
}
order = await kit.status(order.id);
ok(`state ${order.state}`);

if (order.state === "released") {
  record(true, "order released through the SDK");
  record(events.includes("released"), "the host handler received the released event");
  const payout = await kit.payoutFor(order.id);
  console.log(JSON.stringify(payout, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  record(payout?.label === "MOCK" && payout?.executed === false, "a MOCK-labelled payout instruction is issued");
  record(payout?.target?.amountMinor >= PRICE_EUR, "payout >= priceEUR (floor met)", fmt(payout?.target?.amountMinor ?? 0n));
} else {
  record(false, "order released through the SDK", `stopped at ${order.state} (likely no StableFX route — retry)`);
}

// ── Result ──────────────────────────────────────────────────────────────

step("Result");
info(`event order: ${events.join(" → ")}`);
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : " Full flow PROVEN through the RivoKit facade alone."),
);
process.exit(failed ? 1 : 0);
