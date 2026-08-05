/**
 * Phase 3 exit criterion, refund half: return a cross-chain-funded order to its
 * origin chain (invariant 5, PRD §10 — refunds go back to `receivingChain`).
 *
 * It refunds the very order `live-funding.mjs` funded: money came from Ethereum
 * Sepolia into escrow on Arc, and now goes back the same way. The order was
 * never captured, so the cheap escrow path applies — `void` returns the escrowed
 * USDC to the payer on Arc, then a payer-signed bridge carries it to Sepolia.
 *
 * void is irreversible and the bridge is not atomic with it, so the order is
 * marked `refund_pending` BEFORE anything moves. If the bridge is interrupted
 * the payer already holds the money on Arc — re-running finishes the bridge leg
 * instead of voiding a second time.
 *
 *   node scripts/live-refund.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";
import { createCircleClient } from "./lib/circle.mjs";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from "../src/constants/arc.ts";
import { getPaymentInfoHash } from "../src/escrow/payment-info.ts";
import { ESCROW_SIGNATURES } from "../src/escrow/abi.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { createBridge, BridgeStuckError, BridgeFailedError } from "../src/funding/bridge.ts";
import { refund } from "../src/orchestrator/refund.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";
import { stateFile } from "./lib/state.mjs";

// This network hijacks Circle's DNS (observed live); pin before use.
installCircleDnsPinning();

const FUNDING_STATE = stateFile("live-funding");
const STATE_FILE = stateFile("live-refund");
const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

const env = readEnv();

const ESCROW = getAddress(env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS);
const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);

const arcClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const sepoliaClient = createPublicClient({ chain: sepolia, transport: http() });
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

// ── Step 1: pick up the order funded cross-chain earlier ───────────────

step("Step 1 — load the funded order from live-funding, prepare the refund");

if (!existsSync(FUNDING_STATE)) {
  console.error(`FAILED: ${FUNDING_STATE} is missing. Run live-funding.mjs first.`);
  process.exit(1);
}
const funding = JSON.parse(readFileSync(FUNDING_STATE, "utf8"));
const pi = {
  ...funding.paymentInfo,
  maxAmount: BigInt(funding.paymentInfo.maxAmount),
  salt: BigInt(funding.paymentInfo.salt),
};
const AMOUNT = pi.maxAmount;
const hash = getPaymentInfoHash(pi, ARC_TESTNET_CHAIN_ID, ESCROW);

let order = await store.get(funding.orderId);
if (!order) {
  console.error(`FAILED: order ${funding.orderId} is not in the DB.`);
  process.exit(1);
}
const RECEIVING_CHAIN = order.receiving_chain;
ok(`order ${order.id} — state ${order.state}, receivingChain ${RECEIVING_CHAIN}`);
record(RECEIVING_CHAIN === "Ethereum_Sepolia", "receivingChain is the origin chain (invariant 5)", RECEIVING_CHAIN);

const buyerArcBefore = await arcUsdc(buyer.address);
const buyerSepBefore = await sepUsdc(buyer.address);
info(`buyer: Arc ${fmt(buyerArcBefore)} · Sepolia ${fmt(buyerSepBefore)} USDC`);

const ps0 = await escrow.getPaymentState(hash);
info(`escrow holds ${fmt(ps0.capturableAmount)} USDC (not yet captured)`);

// ── Step 2: record the refund intent BEFORE touching the chain ───────────────

step("Step 2 — refund_pending recorded before the void");

if (order.state === "funded" || order.state === "shipped") {
  order = await store.transition(order.id, "refund_pending");
  ok(`state ${order.state} — recorded BEFORE the void`);
} else {
  ok(`state is already ${order.state} (continuing an earlier run)`);
}

// ── Step 3: void + bridge-back to receivingChain ────────────────────

step("Step 3 — void the escrow, then bridge Arc → Sepolia (invariant 5)");

const arcAdapter = createViemAdapterFromPrivateKey({ privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Arc_Testnet });
const sepAdapter = createViemAdapterFromPrivateKey({ privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Ethereum_Sepolia });
const bridgeBack = {
  fromAdapter: arcAdapter, fromChain: BridgeChain.Arc_Testnet,
  toAdapter: sepAdapter, toChain: BridgeChain.Ethereum_Sepolia,
  amountMinor: AMOUNT, kitKey: env.KIT_KEY,
};

let outcome;
const stillEscrowed = ps0.capturableAmount >= AMOUNT;

if (stillEscrowed) {
  // Happy path: escrow still holds the funds → orchestrator voids + bridges.
  outcome = await refund(
    { escrow, bridge },
    { paymentInfo: pi, amountMinor: AMOUNT, currentState: "funded", mechanism: "void", bridgeBack },
  );
  if (outcome.escrowTxHash && !state.voidRecorded) {
    await store.recordPayment({
      orderId: order.id, nonce: `${hash}:void`, kind: "void",
      status: "confirmed", txHash: outcome.escrowTxHash, chain: "Arc_Testnet", amountMinor: AMOUNT,
    });
    state.voidRecorded = true;
    save();
  }
  ok(`void ${outcome.escrowTxHash ?? "-"}`);
  // If the bridge-back stalled after burning, persist the resumable result so a
  // re-run continues via retry, never a second burn.
  if (outcome.status === "refund_pending" && outcome.stuckPrevious != null) {
    state.bridgeStuck = true;
    state.bridgePrevious = outcome.stuckPrevious;
    save();
  }
} else {
  // Resume: the void already happened; the payer holds USDC on Arc. Finish only
  // the bridge leg — and if it was stuck (burn landed), RESUME via retry, which
  // never burns again. bridgeStuck gates the execute (burn) path out entirely.
  ok("escrow is already empty — the void completed in an earlier run; just continue the bridge");
  try {
    const res = state.bridgeStuck
      ? await bridge.retry(bridgeBack, state.bridgePrevious)
      : await bridge.execute(bridgeBack);
    state.bridgeStuck = false;
    delete state.bridgePrevious;
    save();
    outcome = { mechanism: "void", burnTxHash: res.burnTxHash, mintTxHash: res.mintTxHash, bridged: true, status: "refunded" };
  } catch (e) {
    if (e instanceof BridgeStuckError) {
      state.bridgeStuck = true;
      state.bridgePrevious = e.detail ?? state.bridgePrevious ?? null;
      save();
    } else if (!(e instanceof BridgeFailedError)) {
      throw e;
    }
    outcome = { mechanism: "void", bridged: false, status: "refund_pending", reason: e.message };
  }
}

if (outcome.mintTxHash && !state.bridgeRecorded) {
  await store.recordPayment({
    orderId: order.id, nonce: `${hash}:bridge-back`, kind: "bridge_back",
    status: "confirmed", txHash: outcome.mintTxHash, chain: RECEIVING_CHAIN, amountMinor: AMOUNT,
  });
  state.bridgeRecorded = true;
  save();
}
info(`burn (Arc)     ${outcome.burnTxHash ?? "-"}`);
info(`mint (Sepolia) ${outcome.mintTxHash ?? "-"}`);
record(Boolean(outcome.escrowTxHash) || !stillEscrowed, "escrow returned to the payer (void)");
record(outcome.status === "refunded", "bridge-back completed to the origin chain", outcome.status);

if (outcome.status !== "refunded") {
  console.log(`\n  TERTAHAN — ${outcome.reason ?? "the bridge has not completed"}`);
  console.log("  The payer already holds USDC on Arc. Re-run: the script CONTINUES via retry, it does NOT burn again. DO NOT reset.");
  process.exit(1);
}

// ── Step 4: mark it refunded ─────────────────────────────────────────

step("Step 4 — tandai order refunded");

order = await store.get(order.id);
if (order.state === "refund_pending") {
  order = await store.transition(order.id, "refunded");
}
ok(`order ${order.state}`);
record(order.state === "refunded", "the order reached refunded (terminal state)");

// ── Verification ─────────────────────────────────────────────────────────

step("Verification — funds returned to the origin chain");

await sleep(4000);
const buyerSepAfter = await sepUsdc(buyer.address);
info(`buyer Sepolia ${fmt(buyerSepBefore)} → ${fmt(buyerSepAfter)}  (+${fmt(buyerSepAfter - buyerSepBefore)})`);

const gained = buyerSepAfter - buyerSepBefore;
record(gained > 0n, "USDC arrived back on the origin chain (Sepolia)", fmt(gained));
record(gained <= AMOUNT, "what came back does not exceed what was refunded", `${fmt(gained)} <= ${fmt(AMOUNT)}`);

step("Result");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : " Refund bridge-back PROVEN: Arc escrow → Ethereum Sepolia (invariant 5)."),
);
process.exit(failed ? 1 : 0);
