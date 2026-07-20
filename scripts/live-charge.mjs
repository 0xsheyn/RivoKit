/**
 * `charge` — the direct-settle mode: authorize and capture in one transaction.
 *
 * For payouts where no hold is wanted: an invoice already approved, a contractor
 * milestone already signed off. The money never rests in escrow, so there is no
 * window in which void or reclaim apply — which is exactly why this mode is
 * only appropriate when the payer already trusts the outcome.
 *
 * Contrast with the escrow mode proven elsewhere:
 *   escrow  authorize → (hold) → capture   two transactions, cancellable
 *   direct  charge                          one transaction, not cancellable
 *
 *   node scripts/live-charge.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { createCircleClient } from "./lib/circle.mjs";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from "../src/constants/arc.ts";
import { getPaymentInfoHash, getPayerAgnosticHash, ZERO_ADDRESS } from "../src/escrow/payment-info.ts";
import { ESCROW_SIGNATURES } from "../src/escrow/abi.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { expiriesFor, timeoutPolicyFor } from "../src/orchestrator/policy.ts";

const STATE_FILE = ".live-charge.json";
const AMOUNT = parseUnits("2", 6);
const WEDGE = "contractor_payout";

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

const publicClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
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
  console.log(`${pass ? "  OK  " : " GAGAL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

if (process.argv.includes("--reset") && existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const balanceOf = async (address) => {
  await sleep(250);
  return publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });
};

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

const escrow = createEscrow({ escrowAddress: ESCROW, publicClient, operator: operatorSender });

// ── Setup ──────────────────────────────────────────────────────────────

step("Langkah 1 — susun order mode direct");

const now = Math.floor(Date.now() / 1000);
if (!state.paymentInfo) {
  const exp = expiriesFor(WEDGE, now);
  state.orderId = `chg_${now}_${Math.floor(Math.random() * 1e6)}`;
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
    priceEURMinor: AMOUNT, usdcAmountMinor: AMOUNT, bufferBps: 0,
    receivingChain: "Ethereum_Sepolia",
    mode: "direct", // <- the distinguishing field
    wedge: WEDGE,
    timeoutKind: timeoutPolicyFor(WEDGE), timeoutDeadline: pi.authorizationExpiry,
    paymentInfoHash: hash,
  });
}
ok(`order ${order.id} — mode ${order.mode}, state ${order.state}`);
record(order.mode === "direct", "order tercatat mode direct");

const buyerBefore = await balanceOf(buyer.address);
const merchantBefore = await balanceOf(MERCHANT);
info(`buyer ${fmt(buyerBefore)} · merchant ${fmt(merchantBefore)} USDC`);

// ── charge ─────────────────────────────────────────────────────────────

step("Langkah 2 — charge: authorize + capture dalam SATU transaksi");

let ps = await escrow.getPaymentState(hash);
if (!ps.hasCollectedPayment) {
  await store.transition(order.id, "funding_pending");
  if (!state.signature) {
    state.signature = await buyerWallet.signTypedData({
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

  const tx = await escrow.charge(pi, AMOUNT, TOKEN_COLLECTOR, state.signature, 0, ZERO_ADDRESS);
  await store.recordPayment({
    orderId: order.id, nonce: `${hash}:charge`, kind: "capture",
    status: "confirmed", txHash: tx.txHash, chain: "Arc_Testnet", amountMinor: AMOUNT,
  });
  ok(`charge tuntas — tx ${tx.txHash}`);
  state.chargeTx = tx.txHash;
  save();
  ps = await escrow.getPaymentState(hash);
}

// ── Verify ─────────────────────────────────────────────────────────────

step("Langkah 3 — verifikasi");

await sleep(2000);
const buyerAfter = await balanceOf(buyer.address);
const merchantAfter = await balanceOf(MERCHANT);

info(`buyer    ${fmt(buyerBefore)} → ${fmt(buyerAfter)}`);
info(`merchant ${fmt(merchantBefore)} → ${fmt(merchantAfter)}`);
info(`escrow state: collected=${ps.hasCollectedPayment} capturable=${fmt(ps.capturableAmount)} refundable=${fmt(ps.refundableAmount)}`);

record(ps.hasCollectedPayment, "pembayaran tercatat terkumpul");
record(ps.capturableAmount === 0n, "capturable NOL — tidak ada yang tertahan di escrow");
record(ps.refundableAmount === AMOUNT, "langsung masuk refundable — capture sudah terjadi", fmt(ps.refundableAmount));
record(buyerBefore - buyerAfter === AMOUNT, "buyer terdebit tepat", fmt(buyerBefore - buyerAfter));
record(merchantAfter - merchantBefore === AMOUNT, "merchant menerima langsung", fmt(merchantAfter - merchantBefore));

order = await store.get(order.id);
if (order.state === "funding_pending") {
  order = await store.transition(order.id, "funded", { fundedAt: new Date() });
}
if (order.state === "funded") {
  // Direct mode: funds are already with the receiver, so the order is settled
  // in the same breath. price and output are equal — no FX leg in this mode.
  order = await store.transition(order.id, "released", {
    eurcOutMinor: AMOUNT,
    rebateMinor: 0n,
    settledAt: new Date(),
  });
}
record(order.state === "released", "order selesai di state released", order.state);

step("Hasil");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} lolos.` +
    (failed ? " Ada yang gagal." : " Mode direct-settle (charge) TERBUKTI — satu tx, tanpa hold."),
);
process.exit(failed ? 1 : 0);
