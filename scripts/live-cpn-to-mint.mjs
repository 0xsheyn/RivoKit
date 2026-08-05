/**
 * LIVE — broadcast a CPN EUR/SEPA payment addressed to my own Circle Mint
 * account's EUR wire-in instructions (Bank Frick LI + trackingRef).
 *
 * IRREVERSIBLE once BROADCASTED. Spends 12 USDC of the demo seller's testnet
 * balance. The question: does the Mint EUR balance move?
 */
import { createPublicClient, createWalletClient, erc20Abi, fallback, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createCpnRamp } from "../src/ramp/cpn-ramp.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { sleep } from "../src/lib/rpc.ts";
import {
  ARC_TESTNET_RPC_FALLBACKS, PERMIT2_ADDRESS, USDC_ADDRESS, arcTestnet,
} from "../src/constants/arc.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();
const env = readEnv();
const AMOUNT = process.argv[2] ?? "12";

const signer = privateKeyToAccount(env.SELLER_PRIVATE_KEY);
const transport = () => fallback(ARC_TESTNET_RPC_FALLBACKS.map((u) => http(u)));
const pub = createPublicClient({ chain: arcTestnet, transport: transport() });

const mint = async (p) => {
  const r = await fetch("https://api-sandbox.circle.com" + p, {
    headers: { Authorization: `Bearer ${env.CIRCLE_RAMP_KEY}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Mint ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data;
};
const eurBalance = async () =>
  (await mint("/v1/businessAccount/balances")).available.find((b) => b.currency === "EUR")?.amount ?? "0";

// ── baseline ────────────────────────────────────────────────────────────
const banks = await mint("/v1/businessAccount/banks/wires");
const eurBank = banks.find((b) => b.bankAddress?.country === "DE") ?? banks[0];
const ins = await mint(`/v1/businessAccount/banks/wires/${eurBank.id}/instructions?currency=EUR`);
const eurBefore = await eurBalance();
const usdcBefore = await pub.readContract({
  address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [signer.address],
});
console.log("BEFORE  Mint EUR:", eurBefore, "| seller USDC:", (Number(usdcBefore) / 1e6).toFixed(6));
console.log("target  IBAN:", ins.beneficiaryBank.accountNumber, "| trackingRef:", ins.trackingRef);

// ── prepare (fresh quote — they live ~60s) ──────────────────────────────
const ramp = createCpnRamp({
  apiKey: env.CIRCLE_CPN_KEY,
  corridor: {
    senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US",
    destinationCountry: "LI", blockchain: "ARC-TESTNET", paymentMethodType: "SEPA",
    sourceCurrency: "USDC", destinationCurrency: "EUR",
  },
});

const ADDR_LI = { street: "Landstrasse 14", city: "Balzers", stateProvince: "LI", country: "LI", postalCode: "9496" };
const ADDR_US = { street: "456 Madison Ave", city: "New York", stateProvince: "NY", country: "US", postalCode: "10001" };

const { quote } = await ramp.quote({ sourceAmount: AMOUNT });
const { payment, transaction } = await ramp.prepare({
  quote,
  beneficiaryAccount: [
    { name: "IBAN", value: ins.beneficiaryBank.accountNumber },
    { name: "RECIPIENT_LEGAL_NAME", value: ins.beneficiary.name },
  ],
  travelRule: [
    { name: "ORIGINATOR_NAME", value: "Rivo Co" },
    { name: "BENEFICIARY_NAME", value: ins.beneficiary.name },
    { name: "ORIGINATOR_ADDRESS", value: ADDR_US },
    { name: "BENEFICIARY_ADDRESS", value: ADDR_LI },
    { name: "ORIGINATOR_ACCOUNT_NUMBER", value: "US1234567890" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_NAME", value: "Rivo Bank" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_ADDRESS", value: ADDR_US },
  ],
  senderAddress: signer.address,
  refundAddress: signer.address,
  useCase: "B2B",
  reasonForPayment: "PMT001",
  customerRefId: ins.trackingRef,
});
console.log(`\nPREPARED ${payment.id} · ${quote.sourceAmount.amount} USDC -> ${quote.destinationAmount.amount} EUR`);

// ── Permit2 allowance ───────────────────────────────────────────────────
const permit = BigInt(transaction.messageToBeSigned.message?.permitted?.amount ?? 0);
const allowance = await pub.readContract({
  address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [signer.address, PERMIT2_ADDRESS],
});
if (allowance < permit) {
  const wallet = createWalletClient({ account: signer, chain: arcTestnet, transport: transport() });
  const hash = await wallet.writeContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, permit],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log("approved Permit2 for", (Number(permit) / 1e6).toFixed(6), "USDC ·", hash);
} else {
  console.log("Permit2 allowance already sufficient:", (Number(allowance) / 1e6).toFixed(6));
}

// ── BROADCAST ───────────────────────────────────────────────────────────
const submitted = await ramp.submit({ paymentId: payment.id, transaction }, signer);
console.log("BROADCASTED transaction", submitted.id, "status", submitted.status);

let last = "";
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  const p = await ramp.status(payment.id);
  if (p.status !== last) { last = p.status; console.log(`  [${i}] ${last}`); }
  if (last === "COMPLETED" || last === "FAILED") break;
}

const full = await ramp.status(payment.id);
console.log("\nfinal:", full.status, "| onChain:", JSON.stringify(full.onChainTransactions ?? []));
console.log("destinationAmount:", JSON.stringify(full.destinationAmount));

// ── did the Mint balance move? ──────────────────────────────────────────
console.log("\nwatching Mint EUR balance (baseline " + eurBefore + ") …");
for (let i = 0; i < 12; i++) {
  const now = await eurBalance();
  console.log(`  [+${i * 15}s] EUR ${now}${now !== eurBefore ? "   <<< MOVED" : ""}`);
  if (now !== eurBefore) break;
  await sleep(15000);
}
const usdcAfter = await pub.readContract({
  address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [signer.address],
});
console.log("seller USDC:", (Number(usdcBefore) / 1e6).toFixed(6), "->", (Number(usdcAfter) / 1e6).toFixed(6));
