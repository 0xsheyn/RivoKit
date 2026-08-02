/**
 * Exercise the CPN payment states we have never reached, using sandbox magic
 * values — and check each observed status against src/ramp/cpn-state.ts.
 *
 * WHY THIS EXISTS. The fiat leg cannot be verified here. Circle's sandbox is a
 * simulator: statuses are driven by magic values on ORIGINATOR_NAME, and the
 * docs state outright that sandbox refund transaction hashes are "randomly
 * generated" (cpn/references/testing/magic-values). So no run of this script
 * proves money moved. What it CAN prove is the other half of the claim — that
 * every state the fiat leg can report is one our reducer already accepts. Until
 * now only the happy path plus "Failed" had ever been seen.
 *
 * WHAT IT DOES NOT COVER, and why. Four magic values only take effect "after an
 * onchain transaction is received": Delayed, and the three FailThenRefund*
 * variants. Reaching them means a real broadcast — irreversible, and it spends
 * USDC. They are listed at the end as explicitly NOT run rather than quietly
 * skipped, because a probe that hides its own gaps is worse than no probe.
 *
 *   node scripts/probe-cpn-lifecycle.mjs
 *
 * Costs nothing: no payment here is ever funded, and an unfunded CPN payment
 * simply expires.
 */
import { createCpnClient } from "../src/ramp/cpn-client.ts";
import { encryptPaymentData } from "../src/ramp/cpn-encrypt.ts";
import { applyPaymentEvent, rfiEffect, interpretCpnEvent } from "../src/ramp/cpn-state.ts";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();
const cpn = createCpnClient({ apiKey: env.CIRCLE_CPN_KEY });

const SENDER = "0xe251dd0d9db9a097ea25f35e222a8c1f03a68cb5";
const ADDRESS = { street: "1 Rivo St", city: "Paris", state: "IDF", country: "FR", postalCode: "75001" };

/**
 * Magic values whose effect is observable without ever broadcasting.
 *
 * `pollMs` is per-case and the asynchronous ones are generous on purpose. The
 * docs say the async transitions happen "after a few seconds"; measured against
 * sandbox on 2026-08-02 both landed at **t+115s** — roughly twenty times the
 * documented wait. A 20-second window reports them as stuck, which is how this
 * probe first read them.
 */
const NO_BROADCAST = [
  { magic: "AsyncFailed", expect: "CREATED then FAILED (TRAVEL_RULE_FAILED)", pollMs: 150_000 },
  { magic: "Expired", expect: "CRYPTO_FUNDS_PENDING then FAILED (ONCHAIN_SETTLEMENT_CUTOFF_TIME_EXCEEDED)", pollMs: 150_000 },
  { magic: "CreateRfi", expect: "active level 1 RFI in the sync response", pollMs: 8_000 },
  { magic: "CreateRfiL2", expect: "active level 2 RFI in the sync response", pollMs: 8_000 },
  { magic: "CreateRfiL3", expect: "active level 3 RFI in the sync response", pollMs: 8_000 },
  { magic: "AsyncRfi", expect: "CREATED then an RFI appears", pollMs: 20_000 },
];

/** Only reachable by broadcasting real USDC. Named so the gap stays visible. */
const NEEDS_BROADCAST = [
  "Delayed",
  "FailThenRefundWithCompleted",
  "FailThenRefundCreatedThenFailed",
  "FailThenRefundCreatedThenCompleted",
];

async function createPayment(magic) {
  const quote = await cpn.createQuote({
    senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US", destinationCountry: "FR",
    blockchain: "ARC-TESTNET", paymentMethodType: "SEPA", sourceCurrency: "USDC", destinationCurrency: "EUR",
    sourceAmount: "20",
  });
  const travelRule = [
    { name: "ORIGINATOR_NAME", value: magic },
    { name: "BENEFICIARY_NAME", value: "Acme SARL" },
    { name: "ORIGINATOR_ADDRESS", value: ADDRESS },
    { name: "BENEFICIARY_ADDRESS", value: ADDRESS },
    { name: "ORIGINATOR_ACCOUNT_NUMBER", value: "US1234567890" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_NAME", value: "Rivo Bank" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_ADDRESS", value: ADDRESS },
  ];
  const beneficiaryAccount = [
    { name: "IBAN", value: "FR7630006000011234567890189" },
    { name: "RECIPIENT_LEGAL_NAME", value: "Acme SARL" },
  ];
  const enc = await encryptPaymentData(travelRule, beneficiaryAccount, quote.certificate.jwk);
  return cpn.createPayment({
    quoteId: quote.id, blockchain: "ARC-TESTNET", useCase: "B2B", reasonForPayment: "PMT001",
    customerRefId: `probe-${magic}`.slice(0, 64),
    // The field that reaches the beneficiary's bank statement. Set here too so
    // the probe exercises the same shape production sends.
    refCode: `RIVO-PROBE-${magic}`.slice(0, 64),
    senderAddress: SENDER, refundAddress: SENDER, ...enc,
  });
}

/**
 * Read an RFI's real detail.
 *
 * The RFI embedded in a payment response carries only `{type, id, status}` —
 * no level. The level lives on GET /payments/{id}/rfis/{rfiId}, and it is a
 * STRING enum (`LEVEL_1`…`LEVEL_3`), not a number. Reading the embedded object
 * alone made all three CreateRfi magic values print identically, which looked
 * like the probe working while proving nothing about levels at all.
 *
 * Also returned there and worth knowing: `expireDate` (an RFI can time out) and
 * `fieldRequirements`, a JSON Schema describing exactly what must be submitted.
 */
async function rfiDetail(paymentId, rfiId) {
  try {
    const full = await cpn.request("GET", `/v1/cpn/payments/${paymentId}/rfis/${rfiId}`);
    return {
      level: full?.level ?? "?",
      status: full?.status ?? "?",
      expireDate: full?.expireDate ?? null,
      fields: Object.keys(full?.fieldRequirements?.schema?.properties ?? {}),
      // LEVEL_2 and LEVEL_3 ask for an IDENTICAL field set, so the escalation
      // between them is not about fields — it is about documents. Printed so
      // the difference is visible rather than assumed.
      files: Object.keys(full?.fileRequirements?.schema?.properties ?? {}),
    };
  } catch (e) {
    return { level: "unreadable", status: "?", expireDate: null, fields: [], files: [], error: String(e?.message ?? e).slice(0, 120) };
  }
}

/** Feed an observed status through the reducer the webhook path uses. */
function checkAgainstModel(from, status, paymentId) {
  const byStatus = {
    CREATED: "cpn.payment.created",
    CRYPTO_FUNDS_PENDING: "cpn.payment.cryptoFundsPending",
    FIAT_PAYMENT_INITIATED: "cpn.payment.fiatPaymentInitiated",
    COMPLETED: "cpn.payment.completed",
    FAILED: "cpn.payment.failed",
  };
  const type = byStatus[status];
  if (!type) return `no webhook type maps to "${status}" — UNMODELLED`;
  const evt = interpretCpnEvent({ notificationType: type, notification: { id: paymentId } });
  if (!evt) return `interpretCpnEvent returned null for ${type} — UNMODELLED`;
  return JSON.stringify(applyPaymentEvent(from, evt));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

for (const { magic, expect, pollMs } of NO_BROADCAST) {
  process.stdout.write(`\n── ${magic}\n   expect: ${expect}\n`);
  let payment;
  try {
    payment = await createPayment(magic);
  } catch (e) {
    console.log(`   CREATE FAILED: ${String(e?.message ?? e).slice(0, 200)}`);
    results.push({ magic, outcome: "create failed", modelled: "n/a" });
    continue;
  }

  const first = payment.status;
  // Only ids are available on the payment; the level needs the RFI endpoint.
  const rfiOf = (p) => (p.rfis ?? []).map((r) => r?.id).filter(Boolean).join(", ");
  console.log(`   sync  : ${first}`);
  console.log(`   model : ${checkAgainstModel("CREATED", first, payment.id)}`);
  const reportRfis = async (p) => {
    for (const r of p.rfis ?? []) {
      if (!r?.id) continue;
      const d = await rfiDetail(p.id, r.id);
      console.log(
        `   rfi   : ${d.level} · ${d.status}` +
        `${d.expireDate ? ` · expires ${d.expireDate}` : ""}` +
        `${d.fields.length ? ` · ${d.fields.length} fields` : ""}` +
        `${d.files.length ? ` · files [${d.files.join(", ")}]` : " · no files"}` +
        `${d.error ? ` · ${d.error}` : ""}`,
      );
      const eff = rfiEffect(
        interpretCpnEvent({ notificationType: "cpn.rfi.informationRequired", notification: { paymentId: p.id } }),
      );
      console.log(`   model : rfiEffect → ${JSON.stringify(eff)}`);
    }
  };
  await reportRfis(payment);
  let rfiLevels = (await Promise.all((payment.rfis ?? []).map((r) => rfiDetail(payment.id, r.id))))
    .map((d) => d.level).join(", ");

  // Poll for the asynchronous half, within this case's own budget.
  let last = first;
  let lastRfis = rfiOf(payment);
  const STEP = 5000;
  for (let i = 0; i < Math.ceil(pollMs / STEP); i++) {
    await sleep(STEP);
    let cur;
    try {
      cur = await cpn.getPayment(payment.id);
    } catch (e) {
      console.log(`   poll  : read failed — ${String(e?.message ?? e).slice(0, 120)}`);
      break;
    }
    const rfis = rfiOf(cur);
    if (cur.status !== last) {
      console.log(`   poll  : ${last} → ${cur.status}${cur.failureReason ? `  (${cur.failureReason})` : ""}`);
      console.log(`   model : ${checkAgainstModel(last, cur.status, payment.id)}`);
      last = cur.status;
    }
    if (rfis && rfis !== lastRfis) {
      await reportRfis(cur);
      rfiLevels = (await Promise.all((cur.rfis ?? []).map((r) => rfiDetail(cur.id, r.id))))
        .map((d) => d.level).join(", ");
      lastRfis = rfis;
    }
    if (last === "FAILED" || last === "COMPLETED") break;
  }
  results.push({ magic, outcome: `${first} → ${last}`, rfis: rfiLevels || "—" });
}

console.log("\n\n=== Summary ===");
for (const r of results) {
  console.log(`  ${r.magic.padEnd(34)} ${String(r.outcome).padEnd(34)} rfis: ${r.rfis ?? "n/a"}`);
}

console.log("\n=== NOT RUN — these need a real broadcast ===");
for (const m of NEEDS_BROADCAST) console.log(`  ${m}`);
console.log(
  "\nThese only take effect after CPN sees an onchain transaction, so reaching\n" +
  "them costs real USDC and is irreversible. Their refund paths also do NOT\n" +
  "return the onchain funds, and the sandbox txHash is randomly generated —\n" +
  "so even running them would not prove a refund moved money.\n",
);
console.log(
  "REMINDER: nothing above proves fiat landed. Sandbox payments settle nothing;\n" +
  "the only artefact that would let a real beneficiary confirm a credit is\n" +
  "fiatNetworkPaymentRef, which is now stored on the payout reference.\n",
);
