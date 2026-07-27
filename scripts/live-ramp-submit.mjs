/**
 * Live CPN off-ramp — the FULL flow including the irreversible broadcast.
 *
 * Guarded: without CONFIRM=BROADCAST it does a DRY RUN (quote → prepare, then
 * stops). Set CONFIRM=BROADCAST to sign and submit — at which point the sender's
 * USDC leaves for the settlement contract and CANNOT be recalled. On Arc testnet
 * these are testnet funds, but the flow is real.
 *
 *   node scripts/live-ramp-submit.mjs                    # dry run (safe)
 *   CONFIRM=BROADCAST node scripts/live-ramp-submit.mjs  # broadcast (irreversible)
 *
 * Optional: ORIGINATOR_NAME=AsyncSuccess ... to drive a sandbox magic value.
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createCpnRamp } from "../src/ramp/cpn-ramp.ts";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}
const CONFIRM = process.env.CONFIRM === "BROADCAST";
const ORIGINATOR_NAME = process.env.ORIGINATOR_NAME || "Rivo Co";

const signer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
const sender = signer.address;
const ramp = createCpnRamp({
  apiKey: env.CIRCLE_CPN_KEY,
  corridor: {
    senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US", destinationCountry: "FR",
    blockchain: "ARC-TESTNET", paymentMethodType: "SEPA", sourceCurrency: "USDC", destinationCurrency: "EUR",
  },
});

// 1. Quote (12 USDC — above the 11 minimum).
const { quote, fees, spreadBps } = await ramp.quote({ sourceAmount: "12" });
console.log(`QUOTE ${quote.id}: ${quote.sourceAmount.amount} USDC → ${quote.destinationAmount.amount} EUR`);
console.log(`  rate ${quote.exchangeRate.rate}  spread ${Math.round(spreadBps)}bps  fee ${fees.total.amount} USDC  expires ${quote.quoteExpireDate}`);

// 2. Prepare (payment + Permit2 intent). No broadcast yet.
const address = { street: "1 Rivo St", city: "Paris", state: "IDF", country: "FR", postalCode: "75001" };
const { payment, transaction } = await ramp.prepare({
  quote,
  travelRule: [
    { name: "ORIGINATOR_NAME", value: ORIGINATOR_NAME },
    { name: "BENEFICIARY_NAME", value: "Acme SARL" },
    { name: "ORIGINATOR_ADDRESS", value: address },
    { name: "BENEFICIARY_ADDRESS", value: address },
    { name: "ORIGINATOR_ACCOUNT_NUMBER", value: "US1234567890" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_NAME", value: "Rivo Bank" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_ADDRESS", value: address },
  ],
  beneficiaryAccount: [
    { name: "IBAN", value: "FR7630006000011234567890189" },
    { name: "RECIPIENT_LEGAL_NAME", value: "Acme SARL" },
  ],
  senderAddress: sender, refundAddress: sender, useCase: "B2B", reasonForPayment: "PMT001",
  customerRefId: `ramp-${quote.id.slice(0, 8)}`,
});
console.log(`PAYMENT ${payment.id} (${payment.status})  |  TX ${transaction.id} (${transaction.status})`);
console.log(`  sender ${sender}  → settlement ${transaction.messageToBeSigned.message?.spender}`);

if (!CONFIRM) {
  console.log("\nDRY RUN — not submitting. To broadcast (IRREVERSIBLE):");
  console.log("  CONFIRM=BROADCAST node scripts/live-ramp-submit.mjs");
  process.exit(0);
}

// 3. Sign + submit — POINT OF NO RETURN.
console.log("\n⚠️  BROADCAST — signing and sending. The sender's USDC leaves irreversibly.");
const submitted = await ramp.submit({ paymentId: payment.id, transaction }, signer);
console.log(`SUBMITTED tx ${submitted.id}: ${submitted.status}`);

// 4. Follow the payment lifecycle.
let last = payment.status;
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const cur = await ramp.status(payment.id);
  if (cur.status !== last) {
    console.log(`  ${last} → ${cur.status}`);
    last = cur.status;
  } else {
    console.log(`  poll ${i}: ${cur.status}`);
  }
  if (["COMPLETED", "FAILED"].includes(cur.status)) break;
}
console.log(`\nFinal status: ${last}`);
