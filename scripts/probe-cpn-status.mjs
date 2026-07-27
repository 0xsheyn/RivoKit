/**
 * Diagnostic: list recent CPN payments with why-it-is-where detail.
 *
 *   node scripts/probe-cpn-status.mjs
 */
import { readFileSync } from "node:fs";
import { createCpnClient } from "../src/ramp/cpn-client.ts";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}
const cpn = createCpnClient({ apiKey: env.CIRCLE_CPN_KEY });

const res = await cpn.request("GET", "/v1/cpn/payments?pageSize=8");
const payments = Array.isArray(res) ? res : res?.payments ?? res?.data ?? [];

console.log(`${payments.length} most recent payments:\n`);
for (const p of payments) {
  const txs = p.onChainTransactions ?? [];
  console.log(`${p.createDate ?? "?"}  ${p.id}`);
  console.log(`  status: ${p.status}${p.failureReason ? `  failureReason: ${p.failureReason}` : ""}${p.failureCode ? ` (${p.failureCode})` : ""}`);
  console.log(`  ${p.sourceAmount?.amount} ${p.sourceAmount?.currency} → ${p.destinationAmount?.amount} ${p.destinationAmount?.currency}`);
  if (txs.length) {
    for (const t of txs) console.log(`  tx ${t.id ?? "?"}: ${t.status}${t.txHash ? `  ${t.txHash}` : ""}${t.failureReason ? `  ${t.failureReason}` : ""}`);
  } else {
    console.log(`  onChainTransactions: [] (no tx attached yet)`);
  }
  if ((p.rfis ?? []).length) console.log(`  rfis: ${p.rfis.map((r) => r.status).join(", ")}`);
  console.log();
}
