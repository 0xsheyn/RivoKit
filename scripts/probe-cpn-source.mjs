/**
 * Probe: which SOURCE currencies can CPN off-ramp, and from which chain?
 *
 * This decides how `release()` can reach a bank. Settlement ends with EURC on
 * Arc, but every proven cash-out so far sourced USDC. If CPN accepts EURC on
 * ARC-TESTNET, the seller's floored EURC off-ramps directly with no second FX
 * leg. If it does not, the payout leg has to start from USDC and the EURC floor
 * cannot itself be the thing that leaves the chain.
 *
 * Read-only: overview + routes. No quote, no payment, nothing irreversible.
 *
 *   node scripts/probe-cpn-source.mjs           # FR (EUR/SEPA) + US (USD/WIRE)
 *   node scripts/probe-cpn-source.mjs FR DE
 */
import { createCpnClient } from "../src/ramp/cpn-client.ts";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();
const key = env.CIRCLE_CPN_KEY;
if (!key) {
  console.error("FAILED: CIRCLE_CPN_KEY missing from .env.local. Run: node scripts/sync-env.mjs");
  process.exit(1);
}

const cpn = createCpnClient({ apiKey: key });
const countries = process.argv.slice(2).length ? process.argv.slice(2) : ["FR", "US"];

const overview = await cpn.getOverview();
console.log("sourceCurrencies:", JSON.stringify(overview.sourceCurrencies));
console.log("destinationCountries:", (overview.destinationCountries ?? []).length, "countries\n");

const hasEurc = (overview.sourceCurrencies ?? []).some((c) => c.toUpperCase() === "EURC");
console.log(hasEurc ? "EURC IS a listed source currency" : "EURC is NOT a listed source currency");
console.log("");

// Routes are per (sourceCurrency, destinationCountry). Ask for every source the
// account actually has, so the answer covers what is possible rather than what
// we assumed.
for (const country of countries) {
  for (const src of overview.sourceCurrencies ?? []) {
    let routes;
    try {
      routes = await cpn.listRoutes({ sourceCurrency: src, destinationCountry: country });
    } catch (e) {
      console.log(`${src} -> ${country}: ERROR ${e.message}`);
      continue;
    }
    const arc = routes.filter((r) => String(r.blockchain).toUpperCase().includes("ARC"));
    console.log(`${src} -> ${country}: ${routes.length} routes, ${arc.length} on Arc`);
    for (const r of arc) {
      console.log(
        `   ${r.blockchain} ${r.destinationCurrency}/${r.paymentMethodType}` +
          ` crypto ${r.cryptoLimit?.min}-${r.cryptoLimit?.max} ${r.cryptoLimit?.currency}` +
          ` fiat ${r.fiatLimit?.min}-${r.fiatLimit?.max} ${r.fiatLimit?.currency}`,
      );
    }
  }
  console.log("");
}
