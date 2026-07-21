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
import { createBridge } from "../src/funding/bridge.ts";
import { refund } from "../src/orchestrator/refund.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";

// This network hijacks Circle's DNS (see dns-api-circle-dibajak); pin before use.
installCircleDnsPinning();

const FUNDING_STATE = ".live-funding.json";
const STATE_FILE = ".live-refund.json";
const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

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
  console.log(`${pass ? "  OK  " : " GAGAL"}  ${label}${detail ? ` — ${detail}` : ""}`);
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
      throw new Error(`${functionName} ${s}: ${t.transaction?.errorReason ?? "tanpa alasan"}`);
    }
  }
  throw new Error(`${functionName}: timeout`);
};

const escrow = createEscrow({ escrowAddress: ESCROW, publicClient: arcClient, operator: operatorSender });

// ── Langkah 1: ambil order yang tadi didanai lintas-chain ──────────────

step("Langkah 1 — muat order funded dari live-funding, siapkan refund");

if (!existsSync(FUNDING_STATE)) {
  console.error(`GAGAL: ${FUNDING_STATE} tak ada. Jalankan live-funding.mjs dulu.`);
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
  console.error(`GAGAL: order ${funding.orderId} tak ada di DB.`);
  process.exit(1);
}
const RECEIVING_CHAIN = order.receiving_chain;
ok(`order ${order.id} — state ${order.state}, receivingChain ${RECEIVING_CHAIN}`);
record(RECEIVING_CHAIN === "Ethereum_Sepolia", "receivingChain adalah chain asal (invariant 5)", RECEIVING_CHAIN);

const buyerArcBefore = await arcUsdc(buyer.address);
const buyerSepBefore = await sepUsdc(buyer.address);
info(`buyer: Arc ${fmt(buyerArcBefore)} · Sepolia ${fmt(buyerSepBefore)} USDC`);

const ps0 = await escrow.getPaymentState(hash);
info(`escrow menahan ${fmt(ps0.capturableAmount)} USDC (belum di-capture)`);

// ── Langkah 2: catat niat refund SEBELUM menyentuh chain ───────────────

step("Langkah 2 — refund_pending dicatat sebelum void");

if (order.state === "funded" || order.state === "shipped") {
  order = await store.transition(order.id, "refund_pending");
  ok(`state ${order.state} — dicatat SEBELUM void`);
} else {
  ok(`state sudah ${order.state} (lanjutan run sebelumnya)`);
}

// ── Langkah 3: void + bridge-back ke receivingChain ────────────────────

step("Langkah 3 — void escrow lalu bridge Arc → Sepolia (invariant 5)");

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
} else {
  // Resume: the void already happened in an interrupted run; the payer holds
  // the USDC on Arc. Only the bridge leg is left — finish it, do not void again.
  ok("escrow sudah kosong — void tuntas di run sebelumnya; lanjutkan bridge saja");
  const res = await bridge.execute(bridgeBack);
  outcome = {
    mechanism: "void",
    burnTxHash: res.burnTxHash,
    mintTxHash: res.mintTxHash,
    bridged: res.state === "success",
    status: res.state === "success" ? "refunded" : "refund_pending",
  };
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
record(Boolean(outcome.escrowTxHash) || !stillEscrowed, "escrow dikembalikan ke payer (void)");
record(outcome.status === "refunded", "bridge-back tuntas ke chain asal", outcome.status);

if (outcome.status !== "refunded") {
  console.log(`\n  TERTAHAN — ${outcome.reason ?? "bridge belum tuntas"}`);
  console.log("  Payer sudah pegang USDC di Arc. Jalankan ulang untuk menuntaskan bridge; JANGAN reset.");
  process.exit(1);
}

// ── Langkah 4: tandai refunded ─────────────────────────────────────────

step("Langkah 4 — tandai order refunded");

order = await store.get(order.id);
if (order.state === "refund_pending") {
  order = await store.transition(order.id, "refunded");
}
ok(`order ${order.state}`);
record(order.state === "refunded", "order mencapai refunded (state terminal)");

// ── Verifikasi ─────────────────────────────────────────────────────────

step("Verifikasi — dana kembali ke chain asal");

await sleep(4000);
const buyerSepAfter = await sepUsdc(buyer.address);
info(`buyer Sepolia ${fmt(buyerSepBefore)} → ${fmt(buyerSepAfter)}  (+${fmt(buyerSepAfter - buyerSepBefore)})`);

const gained = buyerSepAfter - buyerSepBefore;
record(gained > 0n, "USDC tiba kembali di chain asal (Sepolia)", fmt(gained));
record(gained <= AMOUNT, "yang kembali tidak melebihi yang di-refund", `${fmt(gained)} <= ${fmt(AMOUNT)}`);

step("Hasil");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} lolos.` +
    (failed ? " Ada yang gagal." : " Refund bridge-back TERBUKTI: escrow Arc → Ethereum Sepolia (invariant 5)."),
);
process.exit(failed ? 1 : 0);
