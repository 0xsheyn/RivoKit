/**
 * Live proof of the CPN off-ramp — the SAME orchestrator the demo uses.
 *
 * Runs the SAFE half end-to-end against sandbox: quote → prepare (creates the
 * payment and the Permit2 intent) and STOPS before submit. No broadcast, no
 * funds move. The final signed submit is a deliberate step that needs the
 * sender's funded Arc wallet + Permit2 allowance.
 *
 *   node scripts/live-ramp.mjs
 */
import { createCpnRamp } from "../src/ramp/cpn-ramp.ts";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();
if (!env.CIRCLE_CPN_KEY) {
  console.error("FAILED: CIRCLE_CPN_KEY is missing. Run: node scripts/sync-env.mjs");
  process.exit(1);
}

const ramp = createCpnRamp({
  apiKey: env.CIRCLE_CPN_KEY,
  corridor: {
    senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US", destinationCountry: "FR",
    blockchain: "ARC-TESTNET", paymentMethodType: "SEPA", sourceCurrency: "USDC", destinationCurrency: "EUR",
  },
});

// 1. Quote.
const { quote, fees, spreadBps } = await ramp.quote({ sourceAmount: "20" });
console.log(`QUOTE ${quote.id}`);
console.log(`  ${quote.sourceAmount.amount} ${quote.sourceAmount.currency} → ${quote.destinationAmount.amount} ${quote.destinationAmount.currency}`);
console.log(`  rate ${quote.exchangeRate.rate}  spread ${Math.round(spreadBps)} bps  fee ${fees.total.amount} ${fees.total.currency}`);
console.log(`  expires ${quote.quoteExpireDate}`);

// 2. Prepare (creates payment + transaction, NO broadcast).
const addr = "0xe251dd0d9db9a097ea25f35e222a8c1f03a68cb5";
const address = { street: "1 Rivo St", city: "Paris", state: "IDF", country: "FR", postalCode: "75001" };
const { payment, transaction } = await ramp.prepare({
  quote,
  travelRule: [
    { name: "ORIGINATOR_NAME", value: "Rivo Co" },
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
  senderAddress: addr, refundAddress: addr, useCase: "B2B", reasonForPayment: "PMT001",
  customerRefId: `ramp-${quote.id.slice(0, 8)}`,
});

console.log(`\nPAYMENT ${payment.id}  status ${payment.status}`);
console.log(`TRANSACTION ${transaction.id}  status ${transaction.status}`);
console.log(`  intent: ${transaction.messageToBeSigned.primaryType} on chainId ${transaction.messageToBeSigned.domain.chainId}`);
console.log(`  spender (settlement): ${transaction.messageToBeSigned.message?.spender}`);
console.log(`\n(STOP — not submitting. Broadcast is the point of no return; it needs a funded Arc wallet + a Permit2 allowance.)`);
