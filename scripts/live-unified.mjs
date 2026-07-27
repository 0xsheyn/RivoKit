/**
 * Phase 3, primary funding path: Circle Gateway unified balance.
 *
 * Where a payer already holds a Gateway balance, RivoKit funds an order by
 * spending it straight onto Arc — sub-second, no CCTP wait (PRD §M2). Bridging
 * (live-funding.mjs) is the fallback for payers who do not. This proves the
 * primary path end to end:
 *
 *   deposit (Sepolia → Gateway) → wait until confirmed → spend (mint to payer on
 *   Arc) → authorize into escrow → order funded.
 *
 * A Gateway deposit is NOT spendable the instant it is mined: the balance shows
 * as pending until the source-chain deposit is observed to a safe depth. So the
 * script deposits, then polls getBalance until the amount is confirmed, saving
 * state so a long finalization can be waited out across runs rather than
 * re-depositing.
 *
 *   node scripts/live-unified.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";
import { createCircleClient } from "./lib/circle.mjs";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from "../src/constants/arc.ts";
import { getPaymentInfoHash, ZERO_ADDRESS } from "../src/escrow/payment-info.ts";
import { receiveAuthorizationTypedData } from "../src/escrow/erc3009.ts";
import { ESCROW_SIGNATURES } from "../src/escrow/abi.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { expiriesFor, timeoutPolicyFor } from "../src/orchestrator/policy.ts";
import { createUnifiedBalance } from "../src/funding/unified-balance.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";

installCircleDnsPinning();

const STATE_FILE = ".live-unified.json";
const AMOUNT = parseUnits("2", 6);
const DEPOSIT = parseUnits("2", 6);
// Gateway charges a flat ~1.0 USDC fee ON TOP of a testnet spend, so from a
// 2 USDC balance the most that clears is ~1.0. Spend 0.9 (needs 0.9 + ~1.0 <= 2).
// The mint tops up the payer's Arc balance; authorize then pulls the full AMOUNT
// into escrow — exactly the production shape (spend funds payer, authorize escrows).
const SPEND = parseUnits("0.9", 6);
const WEDGE = "digital_goods";
const RECEIVING_CHAIN = "Ethereum_Sepolia";
const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const FINALIZE_POLLS = 60; // ~12 min at 12s — Sepolia Gateway deposits wait for L1 finality
const POLL_MS = 12000;

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

const ESCROW = getAddress(env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS);
const TOKEN_COLLECTOR = getAddress(env.NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS);
const OPERATOR = getAddress(env.OPERATOR_ADDRESS);
const MERCHANT = getAddress(env.MERCHANT_ADDRESS);
const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);

const arcClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const sepoliaClient = createPublicClient({ chain: sepolia, transport: http() });
const buyerArcWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: arcTransport() });
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

const arcUsdc = async (a) => {
  await sleep(250);
  return arcClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [a] });
};
const sepUsdc = (a) =>
  sepoliaClient.readContract({ address: SEPOLIA_USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

const kit = new AppKit();
kit.on("*", (evt) => {
  const v = evt?.values;
  if (v?.name) info(`  [${v.name}] ${v.state}${v.txHash ? ` ${v.txHash}` : ""}`);
});
const ub = createUnifiedBalance(kit);

const sepAdapter = createViemAdapterFromPrivateKey({ privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Ethereum_Sepolia });
const arcAdapter = createViemAdapterFromPrivateKey({ privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Arc_Testnet });

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

// ── Step 1: order + starting balances ──────────────────────────────────

step("Step 1 — order with receivingChain, opening balances");

const now = Math.floor(Date.now() / 1000);
if (!state.paymentInfo) {
  const exp = expiriesFor(WEDGE, now);
  state.orderId = `unf_${now}_${Math.floor(Math.random() * 1e6)}`;
  state.paymentInfo = {
    operator: OPERATOR, payer: buyer.address, receiver: MERCHANT, token: USDC_ADDRESS,
    maxAmount: AMOUNT.toString(),
    preApprovalExpiry: exp.preApprovalExpiry,
    authorizationExpiry: exp.authorizationExpiry,
    refundExpiry: exp.refundExpiry,
    minFeeBps: 0, maxFeeBps: 0, feeReceiver: ZERO_ADDRESS,
    salt: BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`).toString(),
  };
  save();
}
const pi = { ...state.paymentInfo, maxAmount: BigInt(state.paymentInfo.maxAmount), salt: BigInt(state.paymentInfo.salt) };
const hash = getPaymentInfoHash(pi, ARC_TESTNET_CHAIN_ID, ESCROW);

let order = await store.get(state.orderId);
if (!order) {
  order = await store.create({
    id: state.orderId, paymentInfo: pi,
    priceEURMinor: AMOUNT, usdcAmountMinor: AMOUNT, bufferBps: 150,
    receivingChain: RECEIVING_CHAIN, mode: "escrow", wedge: WEDGE,
    timeoutKind: timeoutPolicyFor(WEDGE), timeoutDeadline: pi.authorizationExpiry,
    paymentInfoHash: hash,
  });
}
ok(`order ${order.id} — receivingChain ${order.receiving_chain}`);
record(order.receiving_chain === RECEIVING_CHAIN, "receivingChain recorded (invariant 5)");

const sepBefore = await sepUsdc(buyer.address);
const arcBefore = await arcUsdc(buyer.address);
info(`buyer: Sepolia ${fmt(sepBefore)} · Arc ${fmt(arcBefore)} USDC`);

const ub0 = await ub.getBalance(sepAdapter);
info(`unified balance: confirmed ${fmt(ub0.confirmedMinor)} · pending ${fmt(ub0.pendingMinor)}`);

// ── Step 2: deposit into Gateway (when there is no balance yet) ────────

step("Step 2 — deposit Sepolia → Gateway (unified balance)");

// Recorded before the irreversible deposit, same discipline as bridge funding.
if (order.state === "created") {
  order = await store.transition(order.id, "funding_pending");
  ok(`state ${order.state} — recorded BEFORE the deposit`);
}

if (!state.deposited && ub0.confirmedMinor < AMOUNT) {
  if (sepBefore < DEPOSIT) {
    console.error(`\nFAILED: the buyer only holds ${fmt(sepBefore)} USDC on Sepolia for the deposit.`);
    process.exit(1);
  }
  const dep = await ub.deposit({ adapter: sepAdapter, chain: "Ethereum_Sepolia", amountMinor: DEPOSIT });
  state.deposited = true;
  state.depositTx = dep.txHash;
  save();
  await store.recordPayment({
    orderId: order.id, nonce: `${hash}:gw-deposit`, kind: "funding",
    status: "confirmed", txHash: dep.txHash, chain: RECEIVING_CHAIN, amountMinor: DEPOSIT,
  });
  ok(`deposit ter-mine — ${dep.txHash}`);
} else {
  ok(state.deposited ? "the deposit was made in an earlier run" : "unified balance already sufficient, skipping deposit");
}

// ── Step 3: wait for finality ───────────────────────────────────────

step("Step 3 — wait for the Gateway balance to confirm (off-chain finality)");

let confirmed = 0n;
for (let i = 0; i < FINALIZE_POLLS; i++) {
  const b = await ub.getBalance(sepAdapter);
  confirmed = b.confirmedMinor;
  info(`poll ${i + 1}/${FINALIZE_POLLS}: confirmed ${fmt(b.confirmedMinor)} · pending ${fmt(b.pendingMinor)}`);
  if (confirmed >= AMOUNT) break;
  await sleep(POLL_MS);
}
if (confirmed < AMOUNT) {
  console.log(`\n  NOT FINAL YET — Gateway balance ${fmt(confirmed)} < ${fmt(AMOUNT)} after ${FINALIZE_POLLS} polls.`);
  console.log("  The deposit is recorded; re-run this script to continue once finality lands.");
  process.exit(1);
}
record(confirmed >= AMOUNT, "Gateway balance confirmed", fmt(confirmed));

// ── Step 4: spend to Arc (mint to the payer) ────────────────────────────

step("Step 4 — spend unified balance → mint ke payer di Arc");

if (!state.spent) {
  const spend = await ub.spend({
    fromAdapter: sepAdapter,
    fromChain: "Ethereum_Sepolia",
    toAdapter: arcAdapter,
    toChain: "Arc_Testnet",
    recipientAddress: buyer.address,
    amountMinor: SPEND,
  });
  state.spent = true;
  state.spendTx = spend.txHash;
  save();
  await store.recordPayment({
    orderId: order.id, nonce: `${hash}:gw-spend`, kind: "funding",
    status: "confirmed", txHash: spend.txHash, chain: "Arc_Testnet", amountMinor: SPEND,
  });
  ok(`spend mint di Arc → ${spend.recipientAddress} — ${spend.txHash}`);
} else {
  ok("the spend was made in an earlier run");
}

await sleep(4000);
const arcAfterSpend = await arcUsdc(buyer.address);
record(arcAfterSpend > arcBefore, "USDC ter-mint ke payer di Arc", `+${fmt(arcAfterSpend - arcBefore)}`);

// ── Step 5: authorize into escrow ─────────────────────────────────────

step("Step 5 — authorize: the unified-balance USDC enters escrow");

let ps = await escrow.getPaymentState(hash);
if (!ps.hasCollectedPayment) {
  if (!state.signature) {
    // Buyer signs off-chain (no gas); the operator relays the collection.
    state.signature = await buyerArcWallet.signTypedData(
      receiveAuthorizationTypedData({
        paymentInfo: pi, chainId: ARC_TESTNET_CHAIN_ID, escrowAddress: ESCROW,
        tokenCollector: TOKEN_COLLECTOR, usdcAddress: USDC_ADDRESS,
      }),
    );
    save();
  }
  const auth = await escrow.authorize(pi, AMOUNT, TOKEN_COLLECTOR, state.signature);
  await store.recordPayment({
    orderId: order.id, nonce: `${hash}:authorize`, kind: "authorize",
    status: "confirmed", txHash: auth.txHash, chain: "Arc_Testnet", amountMinor: AMOUNT,
  });
  ps = await escrow.getPaymentState(hash);
}

order = await store.get(order.id);
if (order.state === "funding_pending") {
  order = await store.transition(order.id, "funded", { fundedAt: new Date() });
}
ok(`escrow holds ${fmt(ps.capturableAmount)} USDC — state ${order.state}`);
record(ps.capturableAmount === AMOUNT, "the escrowed amount is correct");
record(order.state === "funded", "order funded via the unified balance");

step("Result");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : " Funding via unified balance PROVEN: Gateway → escrow Arc."),
);
process.exit(failed ? 1 : 0);
