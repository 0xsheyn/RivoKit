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
import { getPaymentInfoHash, getPayerAgnosticHash, ZERO_ADDRESS } from "../src/escrow/payment-info.ts";
import { ESCROW_SIGNATURES } from "../src/escrow/abi.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { expiriesFor, timeoutPolicyFor } from "../src/orchestrator/policy.ts";
import { createBridge, BridgeStuckError, BridgeFailedError } from "../src/funding/bridge.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";

// Resolve *.circle.com out of band before any SDK call — this network hijacks
// Circle's DNS (see dns-api-circle-dibajak). Must run before AppKit/Circle use.
installCircleDnsPinning();

const STATE_FILE = ".live-funding.json";
const AMOUNT = parseUnits("2", 6);
const WEDGE = "digital_goods";
const RECEIVING_CHAIN = "Ethereum_Sepolia";
const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

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

// ── Langkah 1: order dengan receivingChain tercatat ────────────────────

step("Langkah 1 — buat order, catat receivingChain untuk refund");

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
record(order.receiving_chain === RECEIVING_CHAIN, "receivingChain tercatat di order (invariant 5)");

const buyerSepBefore = await sepUsdc(buyer.address);
const buyerArcBefore = await arcUsdc(buyer.address);
info(`buyer: Sepolia ${fmt(buyerSepBefore)} · Arc ${fmt(buyerArcBefore)} USDC`);

if (buyerSepBefore < AMOUNT) {
  console.error(`\nGAGAL: buyer hanya punya ${fmt(buyerSepBefore)} USDC di Sepolia.`);
  process.exit(1);
}

// ── Langkah 2: funding lintas-chain ────────────────────────────────────

step("Langkah 2 — bridge Sepolia → Arc (funding lintas-chain)");

// Recorded BEFORE the bridge: the burn is irreversible, so a crash must not
// leave money in flight with no order to attach it to.
if (order.state === "created") {
  order = await store.transition(order.id, "funding_pending");
  ok(`state ${order.state} — dicatat SEBELUM burn`);
}

if (!state.bridged) {
  const sepAdapter = createViemAdapterFromPrivateKey({
    privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Ethereum_Sepolia,
  });
  const arcAdapter = createViemAdapterFromPrivateKey({
    privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Arc_Testnet,
  });

  const t0 = Date.now();
  try {
    const res = await bridge.execute({
      fromAdapter: sepAdapter, fromChain: BridgeChain.Ethereum_Sepolia,
      toAdapter: arcAdapter, toChain: BridgeChain.Arc_Testnet,
      amountMinor: AMOUNT, kitKey: env.KIT_KEY,
    });
    // execute() now throws on a failed bridge, so reaching here means success
    // and a real mint hash. Guard anyway: never record a confirmed payment
    // without proof it landed (the DB enforces confirmed_has_tx).
    if (res.state !== "success" || !res.mintTxHash) {
      throw new BridgeFailedError(`bridge tak sukses: state ${res.state}, mint ${res.mintTxHash ?? "-"}`);
    }
    state.bridged = true;
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

    ok(`bridge selesai dalam ${Math.round((Date.now() - t0) / 1000)} detik — ${res.state}`);
    info(`burn (Sepolia) ${res.burnTxHash ?? "-"}`);
    info(`mint (Arc)     ${res.mintTxHash ?? "-"}`);
    record(res.state === "success", "bridge sukses");
  } catch (e) {
    if (e instanceof BridgeStuckError) {
      // Funds may be in flight — leave the order recoverable, do not fail it.
      await store.transition(order.id, "failed", { failureReason: e.message });
      console.log(`\n  TERTAHAN — ${e.message}`);
      console.log("  Jalankan ulang skrip ini untuk melanjutkan; JANGAN reset.");
      process.exit(1);
    }
    if (e instanceof BridgeFailedError) {
      // Nothing moved — record the reason and stop; a clean re-run is safe.
      await store.transition(order.id, "failed", { failureReason: e.message });
      console.log(`\n  GAGAL — ${e.message}`);
      if (e.networkSuspected) {
        console.log("  Penyebab jaringan (bukan on-chain). Perbaiki DNS Circle lalu ulangi.");
      }
      process.exit(1);
    }
    throw e;
  }
} else {
  ok("bridge sudah tuntas di run sebelumnya");
}

await sleep(4000);
const buyerArcAfterBridge = await arcUsdc(buyer.address);
record(buyerArcAfterBridge > buyerArcBefore, "USDC tiba di Arc", `+${fmt(buyerArcAfterBridge - buyerArcBefore)}`);

// ── Langkah 3: dana masuk escrow ───────────────────────────────────────

step("Langkah 3 — authorize: USDC yang baru tiba masuk escrow");

let ps = await escrow.getPaymentState(hash);
if (!ps.hasCollectedPayment) {
  if (!state.signature) {
    state.signature = await buyerArcWallet.signTypedData({
      domain: { name: "USDC", version: "2", chainId: ARC_TESTNET_CHAIN_ID, verifyingContract: USDC_ADDRESS },
      types: {
        ReceiveWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" },
          { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: buyer.address, to: TOKEN_COLLECTOR, value: pi.maxAmount,
        validAfter: 0n, validBefore: BigInt(pi.preApprovalExpiry),
        nonce: getPayerAgnosticHash(pi, ARC_TESTNET_CHAIN_ID, ESCROW),
      },
    });
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

ok(`escrow menahan ${fmt(ps.capturableAmount)} USDC — state ${order.state}`);
record(ps.capturableAmount === AMOUNT, "jumlah di escrow benar");
record(order.state === "funded", "order mencapai funded lewat jalur lintas-chain");

// ── Verifikasi ─────────────────────────────────────────────────────────

step("Verifikasi");

const buyerSepAfter = await sepUsdc(buyer.address);
info(`buyer Sepolia ${fmt(buyerSepBefore)} → ${fmt(buyerSepAfter)}  (${fmt(buyerSepAfter - buyerSepBefore)})`);
record(buyerSepBefore - buyerSepAfter >= AMOUNT, "USDC keluar dari chain asal", fmt(buyerSepBefore - buyerSepAfter));

const finalOrder = await store.get(order.id);
record(finalOrder.receiving_chain === RECEIVING_CHAIN, "receivingChain tetap tercatat untuk refund");

step("Hasil");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} lolos.` +
    (failed ? " Ada yang gagal." : " Funding lintas-chain TERBUKTI: Ethereum Sepolia → escrow Arc."),
);
process.exit(failed ? 1 : 0);
