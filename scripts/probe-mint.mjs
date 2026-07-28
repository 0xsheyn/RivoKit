/**
 * Prove the Circle Mint redemption leg — stablecoin/fiat balance → bank.
 *
 * Circle Mint is a SEPARATE product from CPN, on base `api-sandbox.circle.com`,
 * authenticated by CIRCLE_RAMP_KEY (the "On/off ramp (Mint)" capability). This
 * is the final fiat leg of the euro-native path: in production, redeem EURC→EUR
 * to a SEPA bank; here the sandbox account is USD, so it redeems USD→wire bank.
 *
 * Flow: check balance → link a mock wire bank (reuse if present) → create a
 * payout (redeem) → show the payout + new balance.
 *
 *   node scripts/probe-mint.mjs
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

const bal = await call("GET", "/v1/businessAccount/balances");
console.log("Mint balance:", JSON.stringify(bal.data));

// Reuse an existing wire bank if any, else create a mock one.
let banks = (await call("GET", "/v1/businessAccount/banks/wires")).data ?? [];
let bank = banks[0];
if (!bank) {
  const created = await call("POST", "/v1/businessAccount/banks/wires", {
    idempotencyKey: randomUUID(),
    accountNumber: "12340010",
    routingNumber: "121000248",
    billingDetails: { name: "Rivo Seller", city: "Boston", country: "US", line1: "100 Money Street", district: "MA", postalCode: "01234" },
    bankAddress: { bankName: "WELLS FARGO BANK, NA", city: "San Francisco", country: "US", line1: "1 Bank St", district: "CA" },
  });
  console.log("Link bank:", created.status, JSON.stringify(created.data).slice(0, 200));
  bank = created.data;
} else {
  console.log("Using linked bank:", bank.id, bank.description ?? "");
}
if (!bank?.id) { console.error("No bank id — stopping."); process.exit(1); }

// Redeem a small amount to the bank.
const payout = await call("POST", "/v1/businessAccount/payouts", {
  idempotencyKey: randomUUID(),
  destination: { type: "wire", id: bank.id },
  amount: { currency: "USD", amount: "10.00" },
});
console.log("\nRedeem (payout):", payout.status);
console.log(JSON.stringify(payout.data, null, 2).slice(0, 600));

const bal2 = await call("GET", "/v1/businessAccount/balances");
console.log("\nBalance after:", JSON.stringify(bal2.data));
