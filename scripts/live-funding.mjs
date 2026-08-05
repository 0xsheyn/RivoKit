/**
 * Phase 3 exit criterion, inbound half: Ethereum Sepolia → escrow on Arc.
 *
 * This is the claim the whole product rests on — "pay from whichever chain your
 * USDC happens to be on". Everything proven so far started with funds already
 * on Arc.
 *
 * The order is recorded as `funding_pending` BEFORE the bridge starts, not
 * after. If the process dies mid-attestation the burn has already happened, so
 * a record written afterwards would never exist for money that has already
 * left the payer.
 *
 *   node scripts/live-funding.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import {
  createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, parseUnits,
} from "viem";
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
import { createBridge, BridgeStuckError, BridgeFailedError } from "../src/funding/bridge.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";
import { stateFile } from "./lib/state.mjs";

// Resolve *.circle.com out of band before any SDK call — this network hijacks
// Circle's DNS (observed live). Must run before any AppKit/Circle use.
installCircleDnsPinning();

const STATE_FILE = stateFile("live-funding");
const AMOUNT = parseUnits("2", 6);
const WEDGE = "digital_goods";
const RECEIVING_CHAIN = "Ethereum_Sepolia";
const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

const env = readEnv();

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
// bigint-safe: a persisted bridge result (state.bridgePrevious) can carry bigints.
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

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
const bridge = createBridge(kit);

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

// ── Step 1: order with receivingChain recorded ─────────────────────────

step("Step 1 — create the order, record receivingChain for the refund");

const now = Math.floor(Date.now() / 1000);
if (!state.paymentInfo) {
  const exp = expiriesFor(WEDGE, now);
  state.orderId = `fnd_${now}_${Math.floor(Math.random() * 1e6)}`;
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
    receivingChain: RECEIVING_CHAIN,
    mode: "escrow", wedge: WEDGE,
    timeoutKind: timeoutPolicyFor(WEDGE), timeoutDeadline: pi.authorizationExpiry,
    paymentInfoHash: hash,
  });
}
ok(`order ${order.id} — receivingChain ${order.receiving_chain}`);
record(order.receiving_chain === RECEIVING_CHAIN, "receivingChain recorded on the order (invariant 5)");

const buyerSepBefore = await sepUsdc(buyer.address);
const buyerArcBefore = await arcUsdc(buyer.address);
info(`buyer: Sepolia ${fmt(buyerSepBefore)} · Arc ${fmt(buyerArcBefore)} USDC`);

if (buyerSepBefore < AMOUNT) {
  console.error(`\nFAILED: the buyer only holds ${fmt(buyerSepBefore)} USDC di Sepolia.`);
  process.exit(1);
}

// ── Step 2: cross-chain funding ────────────────────────────────────

step("Step 2 — bridge Sepolia → Arc (funding lintas-chain)");

// Recorded BEFORE the bridge: the burn is irreversible, so a crash must not
// leave money in flight with no order to attach it to.
if (order.state === "created") {
  order = await store.transition(order.id, "funding_pending");
  ok(`state ${order.state} — recorded BEFORE the burn`);
}

if (!state.bridged) {
  const sepAdapter = createViemAdapterFromPrivateKey({
    privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Ethereum_Sepolia,
  });
  const arcAdapter = createViemAdapterFromPrivateKey({
    privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Arc_Testnet,
  });
  const bridgeParams = {
    fromAdapter: sepAdapter, fromChain: BridgeChain.Ethereum_Sepolia,
    toAdapter: arcAdapter, toChain: BridgeChain.Arc_Testnet,
    amountMinor: AMOUNT, kitKey: env.KIT_KEY,
  };

  // The safety invariant: a burn happens at most ONCE. `bridgeStuck` (set when a
  // prior run's burn landed but attestation didn't) gates the execute path out
  // entirely — a stuck transfer is only ever RESUMED via retry (kit.retryBridge),
  // which continues from attestation and never burns again.
  const resuming = Boolean(state.bridgeStuck);
  const t0 = Date.now();
  try {
    const res = resuming
      ? await bridge.retry(bridgeParams, state.bridgePrevious)
      : await bridge.execute(bridgeParams);
    if (res.state !== "success" || !res.mintTxHash) {
      throw new BridgeFailedError(`bridge did not succeed: state ${res.state}, mint ${res.mintTxHash ?? "-"}`);
    }
    state.bridged = true;
    state.bridgeStuck = false;
    delete state.bridgePrevious;
    state.bridge = { burn: res.burnTxHash, mint: res.mintTxHash };
    save();

    await store.recordPayment({
      orderId: order.id,
      nonce: `${hash}:funding-bridge`,
      kind: "funding",
      status: "confirmed",
      txHash: res.mintTxHash,
      chain: RECEIVING_CHAIN,
      amountMinor: AMOUNT,
    });

    ok(`bridge ${resuming ? "resumed" : "completed"} in ${Math.round((Date.now() - t0) / 1000)}s — ${res.state}`);
    info(`burn (Sepolia) ${res.burnTxHash ?? "-"}`);
    info(`mint (Arc)     ${res.mintTxHash ?? "-"}`);
    record(res.state === "success", "bridge sukses");
  } catch (e) {
    if (e instanceof BridgeStuckError) {
      // Burn landed, attestation didn't. Persist the resumable result and STAY
      // in funding_pending — the funds are in flight, not failed. The next run
      // continues via retry, never a second burn.
      state.bridgeStuck = true;
      state.bridgePrevious = e.detail ?? state.bridgePrevious ?? null;
      save();
      console.log(`\n  TERTAHAN — ${e.message}`);
      console.log("  Re-run: the script CONTINUES via retry (kit.retryBridge), it will NOT burn again. DO NOT reset.");
      process.exit(1);
    }
    if (e instanceof BridgeFailedError) {
      // A transport failure. If we were resuming, the transfer is still in
      // flight — keep it stuck so the next run retries, never falls back to a
      // burn. If not resuming, nothing moved and a clean re-run is safe.
      save();
      console.log(`\n  FAILED — ${e.message}`);
      if (e.networkSuspected) console.log("  Network cause (not on-chain). Fix the Circle DNS, then retry.");
      if (resuming) console.log("  (Still in resume mode — the next run retries, it will not burn again.)");
      process.exit(1);
    }
    throw e;
  }
} else {
  ok("bridge already completed in an earlier run");
}

await sleep(4000);
const buyerArcAfterBridge = await arcUsdc(buyer.address);
record(buyerArcAfterBridge > buyerArcBefore, "USDC arrived on Arc", `+${fmt(buyerArcAfterBridge - buyerArcBefore)}`);

// ── Step 3: funds land in escrow ───────────────────────────────────────

step("Step 3 — authorize: the newly arrived USDC enters escrow");

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
record(order.state === "funded", "the order reached funded via the cross-chain path");

// ── Verification ─────────────────────────────────────────────────────────

step("Verification");

const buyerSepAfter = await sepUsdc(buyer.address);
info(`buyer Sepolia ${fmt(buyerSepBefore)} → ${fmt(buyerSepAfter)}  (${fmt(buyerSepAfter - buyerSepBefore)})`);
record(buyerSepBefore - buyerSepAfter >= AMOUNT, "USDC left the origin chain", fmt(buyerSepBefore - buyerSepAfter));

const finalOrder = await store.get(order.id);
record(finalOrder.receiving_chain === RECEIVING_CHAIN, "receivingChain is still recorded for the refund");

step("Result");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : " Funding lintas-chain PROVEN: Ethereum Sepolia → escrow Arc."),
);
process.exit(failed ? 1 : 0);
