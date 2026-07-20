/**
 * Phase 1 exit criterion, proven live on Arc: fund → capture → refund.
 * USDC only — no FX, no bridge.
 *
 * Resumable: each completed step is written to .live-phase1.json, so an
 * interrupted run (Arc's RPC rate-limits hard) picks up where it stopped
 * instead of re-authorizing and colliding on PaymentAlreadyCollected.
 *
 *   node scripts/live-phase1.mjs          continue / start
 *   node scripts/live-phase1.mjs --reset  start a fresh payment
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  getAddress,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { createCircleClient } from "./lib/circle.mjs";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from "../src/constants/arc.ts";
import {
  getPaymentInfoHash,
  getPayerAgnosticHash,
  ZERO_ADDRESS,
} from "../src/escrow/payment-info.ts";

const STATE_FILE = ".live-phase1.json";
const AMOUNT = parseUnits("1", 6); // 1 USDC — keep the blast radius small.

// ── env ────────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

const ESCROW = getAddress(env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS);
const TOKEN_COLLECTOR = getAddress(env.NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS);
const REFUND_COLLECTOR = getAddress(env.NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS);
const OPERATOR = getAddress(env.OPERATOR_ADDRESS);
const MERCHANT = getAddress(env.MERCHANT_ADDRESS);

const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);

const client = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const buyerWallet = createWalletClient({
  account: buyer,
  chain: arcTestnet,
  transport: arcTransport(),
});
const circle = createCircleClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

// ── resumable state ────────────────────────────────────────────────────
if (process.argv.includes("--reset") && existsSync(STATE_FILE)) {
  writeFileSync(STATE_FILE, "{}");
  console.log("State direset.\n");
}
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);

const balance = async (address) => {
  await sleep(250);
  return client.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
};

const fmt = (v) => `${formatUnits(v, 6)} USDC`;

/** Run a Circle contractExecution and wait for it to settle. */
async function operatorCall(label, abiFunctionSignature, abiParameters) {
  const tx = await circle.contractExecution({
    walletId: env.OPERATOR_WALLET_ID,
    contractAddress: ESCROW,
    abiFunctionSignature,
    abiParameters,
  });
  info(`${label}: id ${tx.id}`);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const t = await circle.getTransaction(tx.id);
    const s = t.transaction?.state;
    if (["COMPLETE", "CONFIRMED"].includes(s)) return t.transaction;
    if (["FAILED", "CANCELLED", "DENIED"].includes(s)) {
      throw new Error(`${label} ${s}: ${t.transaction?.errorReason ?? "tanpa alasan"}`);
    }
  }
  throw new Error(`${label}: timeout`);
}

const PAYMENT_STATE_ABI = [
  {
    type: "function",
    name: "paymentState",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "hasCollectedPayment", type: "bool" },
      { name: "capturableAmount", type: "uint120" },
      { name: "refundableAmount", type: "uint120" },
    ],
  },
];

const readPaymentState = async (hash) => {
  await sleep(250);
  const [hasCollected, capturable, refundable] = await client.readContract({
    address: ESCROW,
    abi: PAYMENT_STATE_ABI,
    functionName: "paymentState",
    args: [hash],
  });
  return { hasCollected, capturable, refundable };
};

// ── Step 0: build PaymentInfo (deterministic, persisted) ───────────────

step("Langkah 0 — susun PaymentInfo");

if (!state.paymentInfo) {
  const now = Math.floor(Date.now() / 1000);
  state.paymentInfo = {
    operator: OPERATOR,
    payer: buyer.address,
    receiver: MERCHANT,
    token: USDC_ADDRESS,
    maxAmount: AMOUNT.toString(),
    preApprovalExpiry: now + 3600,
    authorizationExpiry: now + 7200,
    refundExpiry: now + 86400,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: ZERO_ADDRESS,
    // Random salt so re-running with --reset never collides with a spent hash.
    salt: BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`).toString(),
  };
  save();
}

const pi = {
  ...state.paymentInfo,
  maxAmount: BigInt(state.paymentInfo.maxAmount),
  salt: BigInt(state.paymentInfo.salt),
};

const hash = getPaymentInfoHash(pi, ARC_TESTNET_CHAIN_ID, ESCROW);
const nonce = getPayerAgnosticHash(pi, ARC_TESTNET_CHAIN_ID, ESCROW);

info(`payer     ${pi.payer}`);
info(`receiver  ${pi.receiver}`);
info(`operator  ${pi.operator}`);
info(`jumlah    ${fmt(AMOUNT)}`);
ok(`hash      ${hash}`);
ok(`nonce3009 ${nonce}`);

// Positional tuple for Circle's abiParameters.
const piTuple = [
  pi.operator,
  pi.payer,
  pi.receiver,
  pi.token,
  pi.maxAmount.toString(),
  String(pi.preApprovalExpiry),
  String(pi.authorizationExpiry),
  String(pi.refundExpiry),
  String(pi.minFeeBps),
  String(pi.maxFeeBps),
  pi.feeReceiver,
  pi.salt.toString(),
];

const opening = {
  buyer: await balance(buyer.address),
  merchant: await balance(MERCHANT),
  operator: await balance(OPERATOR),
};
info(`saldo awal — buyer ${fmt(opening.buyer)}, merchant ${fmt(opening.merchant)}, operator ${fmt(opening.operator)}`);

if (opening.buyer < AMOUNT) {
  console.error(`\nGAGAL: buyer hanya punya ${fmt(opening.buyer)}, butuh ${fmt(AMOUNT)}.`);
  process.exit(1);
}

// ── Step 1: buyer signs ERC-3009 ───────────────────────────────────────

step("Langkah 1 — buyer tanda tangan ERC-3009 receiveWithAuthorization");

if (!state.signature) {
  const [tokenName, tokenVersion] = await Promise.all([
    client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "name" }),
    client
      .readContract({
        address: USDC_ADDRESS,
        abi: [{ type: "function", name: "version", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }],
        functionName: "version",
      })
      .catch(() => "2"),
  ]);
  info(`domain EIP-712: name="${tokenName}" version="${tokenVersion}"`);

  state.signature = await buyerWallet.signTypedData({
    domain: {
      name: tokenName,
      version: tokenVersion,
      chainId: ARC_TESTNET_CHAIN_ID,
      verifyingContract: USDC_ADDRESS,
    },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: buyer.address,
      // The COLLECTOR pulls the funds, not the escrow.
      to: TOKEN_COLLECTOR,
      value: pi.maxAmount,
      validAfter: 0n,
      validBefore: BigInt(pi.preApprovalExpiry),
      nonce,
    },
  });
  save();
}
ok(`tanda tangan ${state.signature.slice(0, 26)}… (${(state.signature.length - 2) / 2} byte)`);

// ── Step 2: authorize ──────────────────────────────────────────────────

step("Langkah 2 — operator memanggil authorize (dana masuk escrow)");

let ps = await readPaymentState(hash);
if (!ps.hasCollected) {
  await operatorCall(
    "authorize",
    "authorize((address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256),uint256,address,bytes)",
    [piTuple, AMOUNT.toString(), TOKEN_COLLECTOR, state.signature],
  );
  ps = await readPaymentState(hash);
}
ok(`state escrow — collected=${ps.hasCollected} capturable=${fmt(ps.capturable)} refundable=${fmt(ps.refundable)}`);
if (!ps.hasCollected) {
  console.error("GAGAL: authorize tidak mengubah state.");
  process.exit(1);
}

const afterAuth = { buyer: await balance(buyer.address), merchant: await balance(MERCHANT) };
info(`buyer berkurang ${fmt(opening.buyer - afterAuth.buyer)}`);

// ── Step 3: capture ────────────────────────────────────────────────────

step("Langkah 3 — operator memanggil capture (dana ke merchant)");

if (ps.capturable > 0n) {
  await operatorCall(
    "capture",
    "capture((address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256),uint256,uint16,address)",
    [piTuple, AMOUNT.toString(), "0", ZERO_ADDRESS],
  );
  ps = await readPaymentState(hash);
}
ok(`state escrow — capturable=${fmt(ps.capturable)} refundable=${fmt(ps.refundable)}`);

const afterCapture = { merchant: await balance(MERCHANT) };
const merchantGain = afterCapture.merchant - opening.merchant;
ok(`merchant bertambah ${fmt(merchantGain)}`);
if (merchantGain !== AMOUNT) {
  console.error(`GAGAL: merchant seharusnya bertambah ${fmt(AMOUNT)}.`);
  process.exit(1);
}

// ── Step 4: refund ─────────────────────────────────────────────────────

step("Langkah 4 — operator memanggil refund (dana kembali ke buyer)");
info("catatan: dana refund ditarik dari saldo OPERATOR, bukan dari escrow");

if (ps.refundable > 0n) {
  await operatorCall(
    "refund",
    "refund((address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256),uint256,address,bytes)",
    [piTuple, AMOUNT.toString(), REFUND_COLLECTOR, "0x"],
  );
  ps = await readPaymentState(hash);
}
ok(`state escrow — capturable=${fmt(ps.capturable)} refundable=${fmt(ps.refundable)}`);

const closing = {
  buyer: await balance(buyer.address),
  merchant: await balance(MERCHANT),
  operator: await balance(OPERATOR),
};

// ── Verdict ────────────────────────────────────────────────────────────

step("Hasil");

const buyerNet = closing.buyer - opening.buyer;
const merchantNet = closing.merchant - opening.merchant;
const operatorNet = closing.operator - opening.operator;

info(`buyer     ${fmt(opening.buyer)} → ${fmt(closing.buyer)}  (${buyerNet >= 0n ? "+" : ""}${formatUnits(buyerNet, 6)})`);
info(`merchant  ${fmt(opening.merchant)} → ${fmt(closing.merchant)}  (${merchantNet >= 0n ? "+" : ""}${formatUnits(merchantNet, 6)})`);
info(`operator  ${fmt(opening.operator)} → ${fmt(closing.operator)}  (${operatorNet >= 0n ? "+" : ""}${formatUnits(operatorNet, 6)})`);

const checks = [
  [buyerNet === 0n, "buyer kembali utuh (bayar 1, refund 1)"],
  [merchantNet === AMOUNT, "merchant menerima dan menahan hasil capture"],
  [ps.refundable === 0n, "tidak ada sisa yang bisa di-refund"],
  [ps.capturable === 0n, "tidak ada sisa yang bisa di-capture"],
];
let failed = 0;
for (const [pass, label] of checks) {
  console.log(`${pass ? "  OK  " : " GAGAL"}  ${label}`);
  if (!pass) failed++;
}

console.log(
  `\n${checks.length - failed}/${checks.length} lolos.` +
    (failed ? "" : " Kriteria keluar Fase 1 TERBUKTI: fund → capture → refund."),
);
process.exit(failed ? 1 : 0);
