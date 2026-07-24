/**
 * Prove the recovery path: capture succeeds, swap misses its floor, retry wins.
 *
 * This is the awkward middle of the settlement chain and the one place where a
 * naive implementation loses money's whereabouts. The escrow is already empty,
 * so void and reclaim are gone; the recipient holds the source token; and the
 * order is neither released nor failed. Code written for this state is easy to
 * get wrong precisely because it rarely runs — so run it deliberately.
 *
 *   node scripts/live-recovery.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { createCircleClient } from "./lib/circle.mjs";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS, EURC_ADDRESS } from "../src/constants/arc.ts";
import { getPaymentInfoHash, getPayerAgnosticHash, ZERO_ADDRESS } from "../src/escrow/payment-info.ts";
import { ESCROW_SIGNATURES } from "../src/escrow/abi.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createSettlementFx } from "../src/settlement-fx/swap.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { expiriesFor, timeoutPolicyFor } from "../src/orchestrator/policy.ts";
import { release, retrySettlement } from "../src/orchestrator/release.ts";
import { isCaptured } from "../src/orchestrator/state-machine.ts";

const STATE_FILE = ".live-recovery.json";
const AMOUNT = parseUnits("4", 6);
const WEDGE = "invoice";

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

const balanceOf = async (token, address) => {
  await sleep(250);
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
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
const fx = createSettlementFx({
  kitKey: env.KIT_KEY,
  circleApiKey: env.CIRCLE_API_KEY,
  circleEntitySecret: env.CIRCLE_ENTITY_SECRET,
});
const deps = { escrow, fx, settlementAddress: MERCHANT };

// ── Setup: fund an order ───────────────────────────────────────────────

step("Langkah 1 — siapkan order ter-fund");

const now = Math.floor(Date.now() / 1000);
if (!state.paymentInfo) {
  const exp = expiriesFor(WEDGE, now);
  state.orderId = `rec_${now}_${Math.floor(Math.random() * 1e6)}`;
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

const quote = await fx.quote({ address: MERCHANT, tokenIn: "USDC", tokenOut: "EURC", amountInMinor: AMOUNT });
const honestFloor = (quote.amountOutMinor * 98n) / 100n;
info(`kuotasi ${fmt(AMOUNT)} USDC → ${fmt(quote.amountOutMinor)} EURC`);

let order = await store.get(state.orderId);
if (!order) {
  order = await store.create({
    id: state.orderId, paymentInfo: pi,
    priceEURMinor: honestFloor, usdcAmountMinor: AMOUNT, bufferBps: 150,
    receivingChain: "Ethereum_Sepolia", mode: "escrow", wedge: WEDGE,
    timeoutKind: timeoutPolicyFor(WEDGE), timeoutDeadline: pi.authorizationExpiry,
    paymentInfoHash: hash,
  });
}

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
  await escrow.authorize(pi, AMOUNT, TOKEN_COLLECTOR, state.signature);
  ps = await escrow.getPaymentState(hash);
}
order = await store.get(order.id);
if (order.state !== "funded") order = await store.transition(order.id, "funded", { fundedAt: new Date() });
ok(`order ${order.id} — state ${order.state}, escrow menahan ${fmt(ps.capturableAmount)} USDC`);

// ── Step 2: release with an unreachable floor ──────────────────────────

step("Langkah 2 — release dengan floor MUSTAHIL (capture jalan, swap gagal)");

const merchantUsdcBefore = await balanceOf(USDC_ADDRESS, MERCHANT);
const merchantEurcBefore = await balanceOf(EURC_ADDRESS, MERCHANT);
const impossibleFloor = quote.amountOutMinor * 10n;
info(`floor mustahil ${fmt(impossibleFloor)} EURC`);

const first = await release(deps, {
  paymentInfo: pi, amountMinor: AMOUNT, priceOutMinor: impossibleFloor,
  wedge: WEDGE, proof: { kind: "milestone", ref: "INV-77" }, currentState: order.state,
});

record(first.status === "settlement_pending", "release melaporkan settlement_pending", first.status);
if (first.status === "settlement_pending") info(first.reason);

order = await store.transition(order.id, "settlement_pending", { failureReason: first.reason });
record(order.state === "settlement_pending", "state tersimpan sebagai settlement_pending");
record(isCaptured(order.state), "isCaptured menandai dana sudah keluar escrow");

await sleep(2000);
const psAfterCapture = await escrow.getPaymentState(hash);
const merchantUsdcMid = await balanceOf(USDC_ADDRESS, MERCHANT);
const merchantEurcMid = await balanceOf(EURC_ADDRESS, MERCHANT);

record(psAfterCapture.capturableAmount === 0n, "escrow kosong — capture BERHASIL");
record(psAfterCapture.refundableAmount === AMOUNT, "jumlah ter-capture tercatat", fmt(psAfterCapture.refundableAmount));
record(merchantUsdcMid - merchantUsdcBefore === AMOUNT, "penerima memegang USDC, bukan EURC", `+${fmt(merchantUsdcMid - merchantUsdcBefore)} USDC`);
record(merchantEurcMid === merchantEurcBefore, "EURC penerima belum bertambah", fmt(merchantEurcMid));

// ── Step 3: retry with an honest floor ─────────────────────────────────

step("Langkah 3 — retrySettlement dengan floor wajar");

const fresh = await fx.quote({ address: MERCHANT, tokenIn: "USDC", tokenOut: "EURC", amountInMinor: AMOUNT });
const retryFloor = (fresh.amountOutMinor * 98n) / 100n;
info(`kuotasi baru ${fmt(fresh.amountOutMinor)}, floor ${fmt(retryFloor)}`);

const second = await retrySettlement(deps, { amountMinor: AMOUNT, priceOutMinor: retryFloor });

record(second.status === "released", "retrySettlement berhasil", second.status);

if (second.status === "released") {
  await store.recordPayment({
    orderId: order.id, nonce: `${hash}:swap-retry`, kind: "swap",
    status: "confirmed", txHash: second.swapTxHash, chain: "Arc_Testnet", amountMinor: second.eurcOutMinor,
  });
  order = await store.transition(order.id, "released", {
    eurcOutMinor: second.eurcOutMinor,
    rebateMinor: second.rebateMinor,
    settledAt: new Date(),
  });
  ok(`EURC keluar ${fmt(second.eurcOutMinor)} · rebate ${fmt(second.rebateMinor)}`);

  await sleep(3000);
  const merchantEurcAfter = await balanceOf(EURC_ADDRESS, MERCHANT);
  record(merchantEurcAfter - merchantEurcMid >= retryFloor, "penerima akhirnya menerima EURC >= floor", fmt(merchantEurcAfter - merchantEurcMid));
  record(order.state === "released", "state akhir released");
}

step("Hasil");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} lolos.` +
    (failed ? " Ada yang gagal." : " Jalur pemulihan TERBUKTI: settlement_pending → retry → released."),
);
process.exit(failed ? 1 : 0);
