/**
 * Probe: learn the CPN quote + payment schema empirically from sandbox.
 *
 * The docs' request bodies aren't in the vector index and WebFetch to Circle is
 * blocked by the DNS hijack, so we discover the schema the same way the routes
 * 400 taught us the required query params: send a near-empty body and read which
 * fields the API names as missing. A quote is a price only — it expires in
 * 30-60s and moves no money — so this is safe to run against the live key.
 *
 *   node scripts/probe-cpn-quote.mjs
 */
import { readFileSync } from "node:fs";
import { createCpnClient } from "../src/ramp/cpn-client.ts";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}
const key = env.CIRCLE_CPN_KEY;
if (!key) {
  console.error("GAGAL: CIRCLE_CPN_KEY tidak ada di .env.local");
  process.exit(1);
}

const cpn = createCpnClient({ apiKey: key });

async function probe(label, method, path, body) {
  try {
    const data = await cpn.request(method, path, body);
    console.log(`\n=== ${label} — OK ===`);
    console.log(JSON.stringify(data, null, 2).slice(0, 1200));
    return data;
  } catch (e) {
    console.log(`\n=== ${label} — ${e?.status ?? "ERR"} ===`);
    console.log(JSON.stringify(e?.body ?? String(e), null, 2).slice(0, 1500));
    return null;
  }
}

// 1. Payment requirements — often returns the JSON schema for beneficiary fields.
await probe("GET /v1/cpn/payments/requirements (no params)", "GET", "/v1/cpn/payments/requirements");
await probe(
  "GET /v1/cpn/payments/requirements (corridor params)",
  "GET",
  "/v1/cpn/payments/requirements?sourceCurrency=USDC&destinationCountry=FR&destinationCurrency=EUR&paymentMethodType=SEPA&blockchain=ARC-TESTNET",
);

// 2. Create quote with an empty body — let the validator enumerate required fields.
await probe("POST /v1/cpn/quotes (empty body)", "POST", "/v1/cpn/quotes", {});

// 3. Flat schema (learned from the empty-body errors). Try sourceAmount only.
const base = {
  senderType: "BUSINESS",
  recipientType: "BUSINESS",
  senderCountry: "US",
  destinationCountry: "FR",
  sourceCurrency: "USDC",
  destinationCurrency: "EUR",
  blockchain: "ARC-TESTNET",
  paymentMethodType: "SEPA",
};
await probe("POST quotes (sourceAmount only)", "POST", "/v1/cpn/quotes", { ...base, sourceAmount: "20" });

// 4. If both amounts are demanded, or enums are wrong, this surfaces it too.
const quote = await probe("POST quotes (both amounts)", "POST", "/v1/cpn/quotes", {
  ...base,
  sourceAmount: "20",
  destinationAmount: "18",
});

// 5. If a quote came back, fetch its payment requirements (beneficiary fields).
const quoteId = quote?.quoteId ?? quote?.id;
if (quoteId) {
  await probe(
    `GET payments/requirements?quoteId=${quoteId}`,
    "GET",
    `/v1/cpn/payments/requirements?quoteId=${quoteId}`,
  );
}
