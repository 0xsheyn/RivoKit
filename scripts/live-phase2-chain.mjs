/**
 * Full settlement chain, live: authorize → capture → floored swap.
 *
 * Closes the gap between Phase 1 and Phase 2, which until now were proven
 * separately. The receiver of the capture and the wallet that performs the swap
 * are the SAME address, so RivoKit never holds the funds at any point.
 *
 *   node scripts/live-phase2-chain.mjs [--reset]
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
import { release } from "../src/orchestrator/release.ts";

const STATE_FILE = ".live-phase2-chain.json";
const AMOUNT = parseUnits("5", 6);

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
const fmt = (v) => formatUnits(v, 6);

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
};

if (process.argv.includes("--reset") && existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const balanceOf = async (token, address) => {
  await sleep(250);
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
};

const toTuple = (pi) => [
  pi.operator, pi.payer, pi.receiver, pi.token,
  pi.maxAmount.toString(),
  String(pi.preApprovalExpiry), String(pi.authorizationExpiry), String(pi.refundExpiry),
  String(pi.minFeeBps), String(pi.maxFeeBps), pi.feeReceiver, pi.salt.toString(),
];

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
      throw new Error(`${functionName} ${s}: ${t.transaction?.errorReason ?? "no reason given"}`);
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

// ── Step 0: quote to set an honest floor ───────────────────────────────

step("Step 0 — quote to establish the floor");

const quote = await fx.quote({ address: MERCHANT, tokenIn: "USDC", tokenOut: "EURC", amountInMinor: AMOUNT });
info(`${fmt(AMOUNT)} USDC → estimasi ${fmt(quote.amountOutMinor)} EURC`);

// The recipient's guarantee, 2% under the fresh quote — achievable but real.
const priceOutMinor = (quote.amountOutMinor * 98n) / 100n;
ok(`floor (priceEUR) set to ${fmt(priceOutMinor)} EURC`);

// ── Step 1: build PaymentInfo ──────────────────────────────────────────

step("Step 1 — susun PaymentInfo");

if (!state.paymentInfo) {
  const now = Math.floor(Date.now() / 1000);
  state.paymentInfo = {
    operator: OPERATOR,
    payer: buyer.address,
    // Receiver and swap wallet are the same: RivoKit never holds the funds.
    receiver: MERCHANT,
    token: USDC_ADDRESS,
    maxAmount: AMOUNT.toString(),
    preApprovalExpiry: now + 3600,
    authorizationExpiry: now + 7200,
    refundExpiry: now + 86400,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: ZERO_ADDRESS,
    salt: BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`).toString(),
  };
  save();
}
const pi = { ...state.paymentInfo, maxAmount: BigInt(state.paymentInfo.maxAmount), salt: BigInt(state.paymentInfo.salt) };
const hash = getPaymentInfoHash(pi, ARC_TESTNET_CHAIN_ID, ESCROW);
ok(`hash ${hash}`);

const opening = {
  buyerUsdc: await balanceOf(USDC_ADDRESS, buyer.address),
  merchantUsdc: await balanceOf(USDC_ADDRESS, MERCHANT),
  merchantEurc: await balanceOf(EURC_ADDRESS, MERCHANT),
};
info(`buyer ${fmt(opening.buyerUsdc)} USDC · merchant ${fmt(opening.merchantUsdc)} USDC / ${fmt(opening.merchantEurc)} EURC`);

// ── Step 2: authorize ──────────────────────────────────────────────────

step("Step 2 — buyer tanda tangan + operator authorize");

let ps = await escrow.getPaymentState(hash);
if (!ps.hasCollectedPayment) {
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
ok(`escrow holds ${fmt(ps.capturableAmount)} USDC`);
record(ps.capturableAmount === AMOUNT, "funds entered escrow", fmt(ps.capturableAmount));

// ── Step 3: release = capture + swap, satu panggilan ───────────────────

step("Step 3 — release(): capture, then the floored swap");

const outcome = await release(
  { escrow, fx, settlementAddress: MERCHANT },
  {
    paymentInfo: pi,
    amountMinor: AMOUNT,
    priceOutMinor,
    wedge: "digital_goods",
    proof: { kind: "access_granted", ref: "LIC-8842" },
    currentState: "funded",
  },
);

console.log();
if (outcome.status === "released") {
  ok(`status ${outcome.status}`);
  info(`capture tx ${outcome.captureTxHash ?? "-"}`);
  info(`swap tx    ${outcome.swapTxHash ?? "-"}`);
  info(`EURC out ${fmt(outcome.eurcOutMinor)} · rebate ${fmt(outcome.rebateMinor)}`);
} else {
  console.log(`  status ${outcome.status} — ${outcome.reason}`);
}

// ── Step 4: verify on chain ────────────────────────────────────────────

step("Step 4 — verify on chain");

await sleep(3000);
const closing = {
  buyerUsdc: await balanceOf(USDC_ADDRESS, buyer.address),
  merchantUsdc: await balanceOf(USDC_ADDRESS, MERCHANT),
  merchantEurc: await balanceOf(EURC_ADDRESS, MERCHANT),
};
const finalState = await escrow.getPaymentState(hash);

info(`buyer    ${fmt(opening.buyerUsdc)} → ${fmt(closing.buyerUsdc)} USDC`);
info(`merchant ${fmt(opening.merchantUsdc)} → ${fmt(closing.merchantUsdc)} USDC`);
info(`merchant ${fmt(opening.merchantEurc)} → ${fmt(closing.merchantEurc)} EURC`);

const eurcGained = closing.merchantEurc - opening.merchantEurc;

record(outcome.status === "released", "release completed all the way to EURC");
record(opening.buyerUsdc - closing.buyerUsdc === AMOUNT, "the buyer was debited exactly sekali", fmt(opening.buyerUsdc - closing.buyerUsdc));
record(finalState.capturableAmount === 0n, "escrow is empty after the capture");
record(finalState.refundableAmount === AMOUNT, "the captured amount is recorded as refundable", fmt(finalState.refundableAmount));
record(eurcGained >= priceOutMinor, "the merchant receives >= the floor in EURC", `${fmt(eurcGained)} >= ${fmt(priceOutMinor)}`);

step("Result");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : " Full chain PROVEN: authorize → capture → floored swap."),
);
process.exit(failed ? 1 : 0);
