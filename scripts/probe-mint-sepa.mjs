/**
 * Prove the EURO-NATIVE Circle Mint leg — EURC balance → EUR to a SEPA bank.
 *
 * `probe-mint.mjs` proves the USD wire leg. This is the one the project's story
 * actually rests on: the seller's floor is EURC, so the exit that matters is
 * EUR to a SEPA account, not USD to a US wire.
 *
 * Payouts route through the SAME `/v1/businessAccount/banks/wires` endpoint —
 * Circle picks the rail (wire, SEPA, RTP, SPEI) from the destination bank's
 * country. A SEPA account is therefore just the IBAN variant of that request:
 * `{ idempotencyKey, iban, billingDetails, bankAddress }`, where bankAddress
 * needs only `city` and `country`.
 *
 * Linking a bank is additive and safe, so it runs unattended. The redeem is
 * NOT: a payout cannot be recalled once it settles, so it stays behind an
 * explicit confirmation, the same way `submit` does for CPN.
 *
 *   node scripts/probe-mint-sepa.mjs                 # link + report only
 *   CONFIRM=REDEEM node scripts/probe-mint-sepa.mjs  # also redeem EUR_AMOUNT
 */
import { randomUUID } from "node:crypto";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();

const env = readEnv();
const BASE = "https://api-sandbox.circle.com";
const key = env.CIRCLE_RAMP_KEY;
if (!key) {
  console.error("FAILED: CIRCLE_RAMP_KEY missing from .env.local");
  process.exit(1);
}

const CONFIRM = process.env.CONFIRM === "REDEEM";
const EUR_AMOUNT = process.env.EUR_AMOUNT ?? "10.00";
// Circle's own documented sandbox IBAN. Deliberately German, not French: the
// withdraw-fiat guide warns that accounts domiciled in France or Singapore must
// verify payout recipients in the Console first, or payouts sit in `pending`.
const IBAN = process.env.IBAN ?? "DE31100400480532013000";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, data: parsed?.data ?? parsed };
}

const eur = (bal) => bal?.available?.find((b) => b.currency === "EUR")?.amount ?? "0.00";

const before = (await call("GET", "/v1/businessAccount/balances")).data;
console.log("Balance before:", JSON.stringify(before));

// ── Link (or reuse) the SEPA account ───────────────────────────────────
const banks = (await call("GET", "/v1/businessAccount/banks/wires")).data ?? [];
const last4 = IBAN.slice(-4);
let sepa = banks.find((b) => (b.description ?? "").includes(last4));

if (sepa) {
  console.log(`\nReusing SEPA account: ${sepa.id} — ${sepa.description}`);
} else {
  const created = await call("POST", "/v1/businessAccount/banks/wires", {
    idempotencyKey: randomUUID(),
    iban: IBAN,
    billingDetails: {
      name: "Rivo Seller EU",
      city: "Berlin",
      country: "DE",
      line1: "Unter den Linden 1",
      district: "BE",
      postalCode: "10117",
    },
    bankAddress: { city: "Berlin", country: "DE" },
  });
  console.log(`\nLink SEPA account: ${created.status}`);
  console.log(JSON.stringify(created.data, null, 2).slice(0, 700));
  if (!created.ok) process.exit(1);
  sepa = created.data;
}

// A bank must clear policy before it can receive anything — the account-level
// default-deny that blocked four USD payouts showed up here as `rejected` too.
console.log(`\nstatus=${sepa.status}  policyEvaluation=${sepa.policyEvaluation?.status ?? "—"}  trackingRef=${sepa.trackingRef ?? "—"}`);
if (sepa.transferTypesInfo) console.log("transferTypesInfo:", JSON.stringify(sepa.transferTypesInfo));
console.log(`EUR available: ${eur(before)}`);

if (!CONFIRM) {
  console.log(`\nStopping here — linking only. A payout cannot be recalled.`);
  console.log(`To redeem ${EUR_AMOUNT} EUR to this account:`);
  console.log(`  CONFIRM=REDEEM node scripts/probe-mint-sepa.mjs`);
  process.exit(0);
}

// ── Redeem EUR → SEPA ──────────────────────────────────────────────────
const payout = await call("POST", "/v1/businessAccount/payouts", {
  idempotencyKey: randomUUID(),
  destination: { type: "wire", id: sepa.id },
  amount: { currency: "EUR", amount: EUR_AMOUNT },
});
console.log(`\nRedeem (payout): ${payout.status}`);
console.log(JSON.stringify(payout.data, null, 2).slice(0, 700));
if (!payout.ok) process.exit(1);

// SEPA settles far slower than a USD wire in sandbox: measured ~8–12 minutes
// against ~50 seconds. A 5-minute window reports a healthy payout as if it had
// stalled, so give it 20.
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 30000));
  const p = (await call("GET", `/v1/businessAccount/payouts/${payout.data.id}`)).data;
  const policy = p?.policyEvaluation?.status ?? "—";
  console.log(`  status=${p?.status}  policy=${policy}  ${p?.errorCode ?? ""}`);
  if (p?.status && p.status !== "pending") {
    console.log("\nFinal payout:\n" + JSON.stringify(p, null, 2));
    break;
  }
}

const after = (await call("GET", "/v1/businessAccount/balances")).data;
console.log(`\nEUR ${eur(before)} → ${eur(after)}`);
console.log("Balance after:", JSON.stringify(after));
