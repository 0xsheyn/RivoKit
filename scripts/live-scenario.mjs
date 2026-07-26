/**
 * The scenario from docs/SCENARIO.md, run for real.
 *
 * What makes this different from the earlier live scripts: it starts where a
 * host actually starts — from a price in EUR — and every state change goes
 * through the database, so the state machine and the CHECK constraints built in
 * Phase 1 finally guard a real transaction instead of sitting unused.
 *
 *   host sets priceEUR €18.50
 *     → lockQuote derives what the buyer must pay in USDC
 *     → order persisted (created)
 *     → buyer signs ERC-3009, operator authorizes  (funded)
 *     → release: capture + floored swap             (released)
 *     → surplus rebated to the buyer
 *
 *   node scripts/live-scenario.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { createCircleClient } from "./lib/circle.mjs";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS, EURC_ADDRESS } from "../src/constants/arc.ts";
import { getPaymentInfoHash, getPayerAgnosticHash, ZERO_ADDRESS } from "../src/escrow/payment-info.ts";
import { ESCROW_SIGNATURES } from "../src/escrow/abi.ts";
import { createEscrow } from "../src/escrow/operations.ts";
import { createSettlementFx } from "../src/settlement-fx/swap.ts";
import { toDecimalString } from "../src/settlement-fx/units.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { expiriesFor, timeoutPolicyFor } from "../src/orchestrator/policy.ts";
import { release } from "../src/orchestrator/release.ts";

const STATE_FILE = ".live-scenario.json";

/** €18.50 in micro-EURC — the figure SCENARIO.md and PRD §14 use. */
const PRICE_EUR = 18_500_000n;
const BUFFER_BPS = 150;
const WEDGE = "digital_goods";

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

const circleCall = async (label, walletId, contractAddress, signature, params) => {
  const tx = await circle.contractExecution({
    walletId, contractAddress, abiFunctionSignature: signature, abiParameters: params,
  });
  info(`${label}: id ${tx.id}`);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const t = await circle.getTransaction(tx.id);
    const s = t.transaction?.state;
    if (["COMPLETE", "CONFIRMED"].includes(s)) return { txHash: t.transaction.txHash };
    if (["FAILED", "CANCELLED", "DENIED"].includes(s)) {
      throw new Error(`${label} ${s}: ${t.transaction?.errorReason ?? "tanpa alasan"}`);
    }
  }
  throw new Error(`${label}: timeout`);
};

const operatorSender = ({ functionName, args }) =>
  circleCall(
    functionName,
    env.OPERATOR_WALLET_ID,
    ESCROW,
    ESCROW_SIGNATURES[functionName],
    args.map((a) =>
      a && typeof a === "object" && "operator" in a ? toTuple(a) : typeof a === "bigint" ? a.toString() : a,
    ),
  );

const escrow = createEscrow({ escrowAddress: ESCROW, publicClient, operator: operatorSender });
const fx = createSettlementFx({
  kitKey: env.KIT_KEY,
  circleApiKey: env.CIRCLE_API_KEY,
  circleEntitySecret: env.CIRCLE_ENTITY_SECRET,
});

// ── Langkah 1: host menetapkan harga, SDK mengunci kuotasi ─────────────

step("Langkah 1 — host menetapkan priceEUR, SDK menurunkan usdcAmount");
info(`priceEUR ${fmt(PRICE_EUR)} EUR · buffer ${BUFFER_BPS} bps · wedge ${WEDGE}`);

// Probe near the expected order size. A rate sampled at 1 unit is not a rate:
// thin liquidity moves it sharply with size.
const probeInMinor = 25_000_000n;
const { amountInMinor: usdcAmount, quote } = await fx.lockQuote({
  address: MERCHANT,
  tokenIn: "USDC",
  tokenOut: "EURC",
  priceOutMinor: PRICE_EUR,
  bufferBps: BUFFER_BPS,
  probeInMinor,
});

const impliedRate = Number(quote.amountOutMinor) / Number(quote.amountInMinor);
info(`kuotasi ${fmt(quote.amountInMinor)} USDC → ${fmt(quote.amountOutMinor)} EURC (1 USDC ≈ ${impliedRate.toFixed(6)} EURC)`);
ok(`buyer harus membayar ${fmt(usdcAmount)} USDC`);

// Sanity: the derived amount must actually clear the floor at this rate.
const projected = BigInt(Math.floor(Number(usdcAmount) * impliedRate));
record(projected >= PRICE_EUR, "usdcAmount cukup untuk menutup floor", `proyeksi ${fmt(projected)} >= ${fmt(PRICE_EUR)}`);
record(usdcAmount > PRICE_EUR, "buffer membuat buyer bayar di atas nilai nominal");

const buyerUsdc = await balanceOf(USDC_ADDRESS, buyer.address);
if (buyerUsdc < usdcAmount) {
  console.error(`\nGAGAL: buyer punya ${fmt(buyerUsdc)} USDC, butuh ${fmt(usdcAmount)}.`);
  process.exit(1);
}

// ── Langkah 2: order tersimpan ─────────────────────────────────────────

step("Langkah 2 — buat order di database");

const now = Math.floor(Date.now() / 1000);
if (!state.paymentInfo) {
  const exp = expiriesFor(WEDGE, now);
  state.orderId = `ord_${now}_${Math.floor(Math.random() * 1e6)}`;
  state.paymentInfo = {
    operator: OPERATOR,
    payer: buyer.address,
    receiver: MERCHANT,
    token: USDC_ADDRESS,
    maxAmount: usdcAmount.toString(),
    preApprovalExpiry: exp.preApprovalExpiry,
    authorizationExpiry: exp.authorizationExpiry,
    refundExpiry: exp.refundExpiry,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: ZERO_ADDRESS,
    salt: BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`).toString(),
  };
  save();
}

const pi = { ...state.paymentInfo, maxAmount: BigInt(state.paymentInfo.maxAmount), salt: BigInt(state.paymentInfo.salt) };
const hash = getPaymentInfoHash(pi, ARC_TESTNET_CHAIN_ID, ESCROW);

let order = await store.get(state.orderId);
if (!order) {
  order = await store.create({
    id: state.orderId,
    paymentInfo: pi,
    priceEURMinor: PRICE_EUR,
    usdcAmountMinor: usdcAmount,
    bufferBps: BUFFER_BPS,
    receivingChain: "Ethereum_Sepolia",
    mode: "escrow",
    wedge: WEDGE,
    timeoutKind: timeoutPolicyFor(WEDGE),
    timeoutDeadline: pi.authorizationExpiry,
    paymentInfoHash: hash,
  });
}
ok(`order ${order.id} tersimpan — state ${order.state}`);
record(order.state === "created", "order mulai di state created");
info(`timeout policy: ${order.timeout_kind} (wedge ${WEDGE})`);

// ── Langkah 3: buyer bayar ─────────────────────────────────────────────

step("Langkah 3 — buyer tanda tangan ERC-3009, operator authorize");

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
  const auth = await escrow.authorize(pi, usdcAmount, TOKEN_COLLECTOR, state.signature);
  await store.recordPayment({
    orderId: order.id,
    // Deterministic, not random: a replayed authorize must collide, not double-spend.
    nonce: `${hash}:authorize`,
    kind: "authorize",
    status: "confirmed",
    txHash: auth.txHash,
    chain: "Arc_Testnet",
    amountMinor: usdcAmount,
  });
  ps = await escrow.getPaymentState(hash);
}

order = await store.get(order.id);
if (order.state !== "funded") {
  order = await store.transition(order.id, "funded", { fundedAt: new Date() });
}
ok(`escrow menahan ${fmt(ps.capturableAmount)} USDC — state ${order.state}`);
record(ps.capturableAmount === usdcAmount, "jumlah di escrow sama dengan yang dikunci");

const merchantEurcBefore = await balanceOf(EURC_ADDRESS, MERCHANT);
const buyerEurcBefore = await balanceOf(EURC_ADDRESS, buyer.address);

// ── Langkah 4: rilis ───────────────────────────────────────────────────

step("Langkah 4 — penjual konfirmasi → release (capture + swap ber-floor)");

const outcome = await release(
  { escrow, fx, settlementAddress: MERCHANT },
  {
    paymentInfo: pi,
    amountMinor: usdcAmount,
    priceOutMinor: PRICE_EUR,
    wedge: WEDGE,
    proof: { kind: "access_granted", ref: "LIC-8842" },
    currentState: order.state,
  },
);

if (outcome.status !== "released") {
  console.log(`\n  status ${outcome.status} — ${outcome.reason}`);
  await store.transition(order.id, "failed", { failureReason: outcome.reason });
  record(false, "release tuntas sampai EURC", outcome.reason);
  process.exit(1);
}

await store.recordPayment({
  orderId: order.id, nonce: `${hash}:capture`, kind: "capture",
  status: "confirmed", txHash: outcome.captureTxHash, chain: "Arc_Testnet", amountMinor: usdcAmount,
});
await store.recordPayment({
  orderId: order.id, nonce: `${hash}:swap`, kind: "swap",
  status: "confirmed", txHash: outcome.swapTxHash, chain: "Arc_Testnet", amountMinor: outcome.eurcOutMinor,
});

order = await store.transition(order.id, "released", {
  eurcOutMinor: outcome.eurcOutMinor,
  rebateMinor: outcome.rebateMinor,
  settledAt: new Date(),
});

ok(`state ${order.state}`);
info(`EURC keluar ${fmt(outcome.eurcOutMinor)} · floor ${fmt(PRICE_EUR)} · rebate ${fmt(outcome.rebateMinor)}`);

record(outcome.eurcOutMinor >= PRICE_EUR, "penerima menerima >= priceEUR", `${fmt(outcome.eurcOutMinor)} >= ${fmt(PRICE_EUR)}`);
record(order.eurc_out === outcome.eurcOutMinor.toString(), "eurc_out tersimpan di DB");
record(order.rebate === outcome.rebateMinor.toString(), "rebate tersimpan di DB");

// ── Step 5: send the rebate ────────────────────────────────────────────

step("Langkah 5 — kirim rebate ke buyer");

if (outcome.rebateMinor > 0n) {
  info(`transfer ${fmt(outcome.rebateMinor)} EURC dari merchant → buyer`);
  const rebateTx = await circleCall(
    "rebate", env.MERCHANT_WALLET_ID, EURC_ADDRESS,
    "transfer(address,uint256)",
    [buyer.address, outcome.rebateMinor.toString()],
  );
  await store.recordPayment({
    orderId: order.id, nonce: `${hash}:rebate`, kind: "rebate",
    status: "confirmed", txHash: rebateTx.txHash, chain: "Arc_Testnet", amountMinor: outcome.rebateMinor,
  });
  ok(`rebate terkirim — tx ${rebateTx.txHash}`);
} else {
  info("tidak ada surplus; rebate nol");
}

// ── Verifikasi ─────────────────────────────────────────────────────────

step("Verifikasi akhir");

await sleep(3000);
const merchantEurcAfter = await balanceOf(EURC_ADDRESS, MERCHANT);
const buyerEurcAfter = await balanceOf(EURC_ADDRESS, buyer.address);
const merchantNet = merchantEurcAfter - merchantEurcBefore;
const buyerRebate = buyerEurcAfter - buyerEurcBefore;

info(`merchant EURC ${fmt(merchantEurcBefore)} → ${fmt(merchantEurcAfter)}  (+${fmt(merchantNet)})`);
info(`buyer    EURC ${fmt(buyerEurcBefore)} → ${fmt(buyerEurcAfter)}  (+${fmt(buyerRebate)})`);

record(merchantNet >= PRICE_EUR, "merchant menahan >= priceEUR setelah rebate", `${fmt(merchantNet)} >= ${fmt(PRICE_EUR)}`);
record(buyerRebate === outcome.rebateMinor, "buyer menerima rebate persis", fmt(buyerRebate));

const finalOrder = await store.get(order.id);
record(finalOrder.state === "released", "state akhir di DB adalah released");
record(finalOrder.settled_at !== null, "settled_at tercatat");

step("Hasil");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} lolos.` +
    (failed ? " Ada yang gagal." : ` Skenario utuh TERBUKTI — order ${order.id} tersimpan di DB.`),
);
process.exit(failed ? 1 : 0);
