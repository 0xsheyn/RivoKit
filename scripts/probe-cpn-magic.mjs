/**
 * Validate the payment state model against sandbox using magic values.
 *
 * ORIGINATOR_NAME magic values drive the sandbox to specific statuses without
 * any broadcast: "Failed" fails synchronously; "AsyncSuccess" returns CREATED
 * then moves to CRYPTO_FUNDS_PENDING via an async update we observe by polling
 * getPayment. This confirms the real statuses match src/ramp/cpn-state.ts.
 *
 *   node scripts/probe-cpn-magic.mjs
 */
import { readFileSync } from "node:fs";
import { createCpnClient } from "../src/ramp/cpn-client.ts";
import { encryptPaymentData } from "../src/ramp/cpn-encrypt.ts";
import { applyPaymentEvent, interpretCpnEvent } from "../src/ramp/cpn-state.ts";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}
const cpn = createCpnClient({ apiKey: env.CIRCLE_CPN_KEY });
const addr = "0xe251dd0d9db9a097ea25f35e222a8c1f03a68cb5";
const address = { street: "1 Rivo St", city: "Paris", state: "IDF", country: "FR", postalCode: "75001" };

async function makePayment(originatorName) {
  const quote = await cpn.createQuote({
    senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US", destinationCountry: "FR",
    blockchain: "ARC-TESTNET", paymentMethodType: "SEPA", sourceCurrency: "USDC", destinationCurrency: "EUR",
    sourceAmount: "20",
  });
  const travelRule = [
    { name: "ORIGINATOR_NAME", value: originatorName },
    { name: "BENEFICIARY_NAME", value: "Acme SARL" },
    { name: "ORIGINATOR_ADDRESS", value: address },
    { name: "BENEFICIARY_ADDRESS", value: address },
    { name: "ORIGINATOR_ACCOUNT_NUMBER", value: "US1234567890" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_NAME", value: "Rivo Bank" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_ADDRESS", value: address },
  ];
  const beneficiaryAccount = [
    { name: "IBAN", value: "FR7630006000011234567890189" },
    { name: "RECIPIENT_LEGAL_NAME", value: "Acme SARL" },
  ];
  const enc = await encryptPaymentData(travelRule, beneficiaryAccount, quote.certificate.jwk);
  return cpn.createPayment({
    quoteId: quote.id, blockchain: "ARC-TESTNET", useCase: "B2B", reasonForPayment: "PMT001",
    customerRefId: `magic-${originatorName}`, senderAddress: addr, refundAddress: addr, ...enc,
  });
}

// 1. Synchronous failure.
const failed = await makePayment("Failed");
console.log(`"Failed"      → sync status: ${failed.status}  (expect FAILED)`);

// 2. Async success — poll until it leaves CREATED.
const p = await makePayment("AsyncSuccess");
console.log(`"AsyncSuccess" → sync status: ${p.status}  (expect CREATED)`);
let last = p.status;
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const cur = await cpn.getPayment(p.id);
  if (cur.status !== last) {
    // Feed the observed change through the state machine as its webhook would arrive.
    const evt = interpretCpnEvent({ notificationType: "cpn.payment.cryptoFundsPending", notification: { id: p.id } });
    const applied = applyPaymentEvent("CREATED", evt);
    console.log(`  poll ${i}: ${last} → ${cur.status}  | state-machine: ${JSON.stringify(applied)}`);
    last = cur.status;
    break;
  }
  console.log(`  poll ${i}: still ${cur.status}`);
}
