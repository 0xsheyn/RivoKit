/**
 * Phase 1, remaining lifecycle paths: void and reclaim.
 *
 *   Payment A: authorize → void     (operator cancels; funds still in escrow)
 *   Payment B: authorize → reclaim  (PAYER recovers after authorizationExpiry)
 *
 * reclaim is the one operation RivoKit cannot perform. The contract requires
 * msg.sender == paymentInfo.payer, so a payer can always recover their funds
 * without the operator's cooperation. That is what makes the escrow
 * non-custodial in practice rather than only in description — so it is worth
 * proving live, not assuming.
 *
 *   node scripts/live-phase1b.mjs [--reset]
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
import { getPaymentInfoHash, getPayerAgnosticHash, ZERO_ADDRESS } from "../src/escrow/payment-info.ts";
import { ESCROW_ABI, ESCROW_SIGNATURES } from "../src/escrow/abi.ts";
import { createEscrow } from "../src/escrow/operations.ts";

const STATE_FILE = ".live-phase1b.json";
const AMOUNT = parseUnits("0.5", 6);
/** Short enough to wait out in one run; long enough for authorize to land. */
const RECLAIM_WINDOW_SECONDS = 180;

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

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const fmt = (v) => `${formatUnits(v, 6)} USDC`;

// ── senders ────────────────────────────────────────────────────────────

/** PaymentInfo object → the positional tuple Circle's API expects. */
const toTuple = (pi) => [
  pi.operator, pi.payer, pi.receiver, pi.token,
  pi.maxAmount.toString(),
  String(pi.preApprovalExpiry), String(pi.authorizationExpiry), String(pi.refundExpiry),
  String(pi.minFeeBps), String(pi.maxFeeBps),
  pi.feeReceiver, pi.salt.toString(),
];

/** Operator signs through Circle Developer-Controlled Wallets. */
const operatorSender = async ({ functionName, args }) => {
  const abiParameters = args.map((a) =>
    a && typeof a === "object" && "operator" in a ? toTuple(a) : typeof a === "bigint" ? a.toString() : a,
  );
  const tx = await circle.contractExecution({
    walletId: env.OPERATOR_WALLET_ID,
    contractAddress: ESCROW,
    abiFunctionSignature: ESCROW_SIGNATURES[functionName],
    abiParameters,
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

/** Payer signs in their own wallet — the only way reclaim can happen. */
const payerSender = async ({ functionName, args }) => {
  const txHash = await buyerWallet.writeContract({
    address: ESCROW,
    abi: ESCROW_ABI,
    functionName,
    args,
  });
  info(`${functionName}: tx ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${functionName} revert`);
  return { txHash };
};

const escrow = createEscrow({
  escrowAddress: ESCROW,
  publicClient,
  operator: operatorSender,
  payer: payerSender,
});

// ── state ──────────────────────────────────────────────────────────────

if (process.argv.includes("--reset") && existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const balance = async (a) => {
  await sleep(250);
  return publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [a] });
};

function buildPaymentInfo(key, authWindowSeconds) {
  if (!state[key]) {
    const now = Math.floor(Date.now() / 1000);
    state[key] = {
      operator: OPERATOR,
      payer: buyer.address,
      receiver: MERCHANT,
      token: USDC_ADDRESS,
      maxAmount: AMOUNT.toString(),
      preApprovalExpiry: now + authWindowSeconds,
      authorizationExpiry: now + authWindowSeconds,
      refundExpiry: now + 86400,
      minFeeBps: 0,
      maxFeeBps: 0,
      feeReceiver: ZERO_ADDRESS,
      salt: BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`).toString(),
    };
    save();
  }
  const s = state[key];
  return { ...s, maxAmount: BigInt(s.maxAmount), salt: BigInt(s.salt) };
}

async function signErc3009(pi, nonce) {
  return buyerWallet.signTypedData({
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
      validAfter: 0n, validBefore: BigInt(pi.preApprovalExpiry), nonce,
    },
  });
}

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " GAGAL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// ── Payment A: authorize → void ────────────────────────────────────────

step("Pembayaran A — authorize lalu void (batal sebelum capture)");

const piA = buildPaymentInfo("paymentA", 7200);
const hashA = getPaymentInfoHash(piA, ARC_TESTNET_CHAIN_ID, ESCROW);
info(`hash ${hashA}`);

const buyerBeforeA = await balance(buyer.address);
const operatorBeforeA = await balance(OPERATOR);

let stateA = await escrow.getPaymentState(hashA);
if (!stateA.hasCollectedPayment) {
  if (!state.sigA) {
    state.sigA = await signErc3009(piA, getPayerAgnosticHash(piA, ARC_TESTNET_CHAIN_ID, ESCROW));
    save();
  }
  await escrow.authorize(piA, AMOUNT, TOKEN_COLLECTOR, state.sigA);
  stateA = await escrow.getPaymentState(hashA);
}
ok(`ter-authorize — capturable ${fmt(stateA.capturableAmount)}`);

const buyerAfterAuthA = await balance(buyer.address);
record(buyerBeforeA - buyerAfterAuthA === AMOUNT, "buyer terdebit saat authorize", fmt(buyerBeforeA - buyerAfterAuthA));

if (stateA.capturableAmount > 0n) {
  await escrow.void(piA);
  stateA = await escrow.getPaymentState(hashA);
}
ok(`setelah void — capturable ${fmt(stateA.capturableAmount)}`);

const buyerAfterVoid = await balance(buyer.address);
const operatorAfterVoid = await balance(OPERATOR);

record(stateA.capturableAmount === 0n, "void mengosongkan capturable");
record(buyerAfterVoid === buyerBeforeA, "buyer kembali utuh setelah void", fmt(buyerAfterVoid));
record(
  operatorBeforeA - operatorAfterVoid < AMOUNT,
  "void TIDAK menguras operator (beda dari refund)",
  `operator hanya keluar ${fmt(operatorBeforeA - operatorAfterVoid)} untuk gas`,
);

// ── Payment B: authorize → reclaim ─────────────────────────────────────

step(`Pembayaran B — authorize lalu reclaim oleh payer (tunggu ${RECLAIM_WINDOW_SECONDS} detik)`);

const piB = buildPaymentInfo("paymentB", RECLAIM_WINDOW_SECONDS);
const hashB = getPaymentInfoHash(piB, ARC_TESTNET_CHAIN_ID, ESCROW);
info(`hash ${hashB}`);
info(`authorizationExpiry ${new Date(piB.authorizationExpiry * 1000).toISOString()}`);

const buyerBeforeB = await balance(buyer.address);

let stateB = await escrow.getPaymentState(hashB);
if (!stateB.hasCollectedPayment) {
  if (!state.sigB) {
    state.sigB = await signErc3009(piB, getPayerAgnosticHash(piB, ARC_TESTNET_CHAIN_ID, ESCROW));
    save();
  }
  await escrow.authorize(piB, AMOUNT, TOKEN_COLLECTOR, state.sigB);
  stateB = await escrow.getPaymentState(hashB);
}
ok(`ter-authorize — capturable ${fmt(stateB.capturableAmount)}`);

// Prove the guard: reclaim before expiry must revert.
if (Math.floor(Date.now() / 1000) < piB.authorizationExpiry) {
  let reverted = false;
  try {
    await publicClient.simulateContract({
      address: ESCROW, abi: ESCROW_ABI, functionName: "reclaim",
      args: [piB], account: buyer.address,
    });
  } catch {
    reverted = true;
  }
  record(reverted, "reclaim SEBELUM expiry ditolak kontrak");
}

// Wait out the authorization window.
while (Math.floor(Date.now() / 1000) < piB.authorizationExpiry + 5) {
  const left = piB.authorizationExpiry + 5 - Math.floor(Date.now() / 1000);
  info(`menunggu expiry… ${left} detik`);
  await sleep(Math.min(left, 30) * 1000);
}

if (stateB.capturableAmount > 0n) {
  await escrow.reclaim(piB);
  stateB = await escrow.getPaymentState(hashB);
}
ok(`setelah reclaim — capturable ${fmt(stateB.capturableAmount)}`);

const buyerAfterReclaim = await balance(buyer.address);
record(stateB.capturableAmount === 0n, "reclaim mengosongkan capturable");
record(
  buyerAfterReclaim >= buyerBeforeB - parseUnits("0.05", 6),
  "buyer memulihkan dananya sendiri tanpa operator",
  fmt(buyerAfterReclaim),
);

// ── verdict ────────────────────────────────────────────────────────────

step("Hasil");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} lolos.` +
    (failed ? " Ada yang gagal." : " void dan reclaim TERBUKTI live."),
);
process.exit(failed ? 1 : 0);
