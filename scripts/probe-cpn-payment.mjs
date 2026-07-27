/**
 * Probe: learn the POST /v1/cpn/payments envelope from sandbox.
 *
 * createPayment only creates a CREATED payment — no on-chain broadcast, no money
 * moves — so this is safe. A fresh quote is minted first (it expires in ~60s),
 * then we send progressively fuller bodies and read the validator's "required"
 * errors to discover the envelope, including the ADDRESS sub-shape.
 *
 *   node scripts/probe-cpn-payment.mjs
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createCpnClient } from "../src/ramp/cpn-client.ts";
import { encryptForCpn } from "../src/ramp/cpn-encrypt.ts";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}
const cpn = createCpnClient({ apiKey: env.CIRCLE_CPN_KEY });

async function attempt(label, body) {
  try {
    const d = await cpn.request("POST", "/v1/cpn/payments", body);
    console.log(`\n=== ${label} — OK ===`);
    console.log(JSON.stringify(d, null, 2).slice(0, 1500));
    return d;
  } catch (e) {
    console.log(`\n=== ${label} — ${e?.status ?? "ERR"} ===`);
    const b = e?.body;
    const msg = b?.message ?? b;
    console.log(typeof msg === "string" ? msg : JSON.stringify(msg));
    return null;
  }
}

// Fresh quote for the demo corridor.
const quote = await cpn.createQuote({
  senderType: "BUSINESS",
  recipientType: "BUSINESS",
  senderCountry: "US",
  destinationCountry: "FR",
  blockchain: "ARC-TESTNET",
  paymentMethodType: "SEPA",
  sourceCurrency: "USDC",
  destinationCurrency: "EUR",
  sourceAmount: "20",
});
console.log("quoteId:", quote.id, "expires:", quote.quoteExpireDate);

// Plaintext is a JSON ARRAY of {name,value}; ADDRESS values are objects with
// {street,city,state,country,postalCode} (encrypt how-to Step 4). The encrypted
// array goes in travelRuleData / beneficiaryAccountData as a JWE string.
const address = { street: "1 Rivo St", city: "Paris", state: "IDF", country: "FR", postalCode: "75001" };
const travelRule = [
  { name: "ORIGINATOR_NAME", value: "Rivo Co" },
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
const encTravelRule = await encryptForCpn(travelRule, quote.certificate.jwk);
const encBeneficiary = await encryptForCpn(beneficiaryAccount, quote.certificate.jwk);

const addr = env.OPERATOR_ADDRESS || "0xe251dd0d9db9a097ea25f35e222a8c1f03a68cb5";

const payment = await attempt("createPayment (correct envelope)", {
  idempotencyKey: randomUUID(),
  quoteId: quote.id,
  blockchain: "ARC-TESTNET",
  useCase: "B2B",
  reasonForPayment: "PMT001",
  customerRefId: randomUUID(),
  refCode: randomUUID(),
  senderAddress: addr,
  refundAddress: addr,
  travelRuleData: encTravelRule,
  beneficiaryAccountData: encBeneficiary,
});
if (payment?.id) console.log("\nPAYMENT id:", payment.id, "status:", payment.status, "expire:", payment.expireDate);

// createTransaction only PREPARES the messageToBeSigned — it does NOT broadcast.
// Safe to run; confirms the real Arc Permit2 intent shape. We STOP before submit.
if (payment?.id) {
  try {
    const tx = await cpn.createTransaction(payment.id);
    const m = tx.messageToBeSigned;
    console.log("\nTRANSACTION id:", tx.id, "status:", tx.status);
    console.log("  destinationAddress:", tx.destinationAddress, "amount:", tx.amount?.amount, tx.amount?.currency);
    console.log("  messageType:", tx.messageType, "| primaryType:", m?.primaryType);
    console.log("  domain:", JSON.stringify(m?.domain));
    console.log("  types:", Object.keys(m?.types ?? {}).join(", "));
    console.log("  message.spender:", m?.message?.spender, "| witness.to:", m?.message?.witness?.to);
    console.log("\n(STOP — not signing or submitting. Broadcast is the point of no return.)");
  } catch (e) {
    console.log("\ncreateTransaction:", e?.status ?? "ERR", JSON.stringify(e?.body ?? String(e)).slice(0, 300));
  }
}
