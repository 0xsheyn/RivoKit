/**
 * Probe: does the CPN (Sending) key reach the sandbox, and does the client work?
 *
 * Read-only smoke test driving the real src/ramp/cpn-client.ts against sandbox.
 * It proves the new Sending-only key authenticates, DNS pinning routes
 * api.circle.com past the local hijack, the account is provisioned for CPN, and
 * the typed client + route selector behave against live data. If this passes we
 * can build the quote -> payment -> signed-transaction flow on top.
 *
 * Config and routes are payment rails, not secrets, so printing them is safe;
 * the key itself is never printed.
 *
 *   node scripts/probe-cpn.mjs                # sample corridors
 *   node scripts/probe-cpn.mjs FR DE ES       # dump full routes for countries
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
  console.error("GAGAL: CIRCLE_CPN_KEY tidak ada di .env.local. Jalankan dulu: node scripts/sync-env.mjs");
  process.exit(1);
}

const cpn = createCpnClient({ apiKey: key });
const envLabel = key.startsWith("TEST_") ? "TEST (Arc testnet, data mock)" : "LIVE (Arc mainnet)";
console.log(`CPN probe — key ${envLabel}\n`);

const overview = await cpn.getOverview();
console.log(`  overview: ${overview.sourceCurrencies.join(",")} → ${overview.destinationCountries.length} negara`);

// Confirm the demo corridor exists: USDC(Arc) → EUR/SEPA.
const demo = await cpn.findRoute(
  { sourceCurrency: "USDC", destinationCountry: "FR" },
  { destinationCurrency: "EUR", paymentMethodType: "SEPA", blockchain: "ARC-TESTNET" },
);
console.log(
  `  koridor demo USDC(Arc)→EUR/SEPA: ${demo ? `ADA (min ${demo.cryptoLimit.min} USDC)` : "TIDAK ADA"}`,
);

// With country codes on argv, dump every rail so a corridor can be inspected.
const argvCountries = process.argv.slice(2).map((c) => c.toUpperCase());
const countries = argvCountries.length
  ? argvCountries
  : ["ID", "SG", "FR"].filter((c) => overview.destinationCountries.includes(c));

console.log(`\nRute per negara (sourceCurrency=USDC):`);
for (const country of countries) {
  try {
    const rows = await cpn.listRoutes({ sourceCurrency: "USDC", destinationCountry: country });
    console.log(`  ${country}: ${rows.length} rute`);
    for (const r of rows) {
      const arc = r.blockchain === "ARC-TESTNET";
      const eur = r.destinationCurrency === "EUR";
      const mark = arc && eur ? "  <<< EUR+ARC" : arc ? "  (Arc)" : "";
      console.log(
        `      ${r.destinationCurrency}/${r.paymentMethodType}  on ${r.blockchain}  min ${r.cryptoLimit.min} USDC${mark}`,
      );
    }
  } catch (e) {
    console.log(`  ${country}: ERROR ${e?.status ?? ""} ${String(e?.message ?? e).slice(0, 160)}`);
  }
  await new Promise((r) => setTimeout(r, 800));
}
