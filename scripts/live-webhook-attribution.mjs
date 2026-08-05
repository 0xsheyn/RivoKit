/**
 * Attribution experiment — does a stored cash-out advance from a WEBHOOK alone?
 *
 * The live run on 2026-07-28 proved a webhook arrives, verifies, and folds into
 * `cpn_payments`. What it did not prove is which writer moved the row: the demo
 * broadcasts through `demo/lib/cpn.server.ts`, whose broadcast loop polls CPN
 * every 3s and calls `persistStatus` on every change. Webhook and poller wrote
 * inside the same window, so "the row corrected itself from a webhook" was not
 * a claim the project had earned.
 *
 * This script removes the competing writer instead of trying to out-race it:
 *
 *   - it prepares the payment and records the row (a webhook for a payment we
 *     never stored is dropped as `unknown`, so the row has to exist first),
 *   - it broadcasts,
 *   - and then it NEVER writes status. No `persistStatus`, no `ramp.status()`
 *     during the observation window — the store is read, not driven.
 *
 * Every write to `events` comes from the webhook route and nowhere else, so the
 * rows there are the webhook's fingerprint. If `cpn_payments` advances while
 * this process only reads, the webhook is the only thing that could have moved
 * it.
 *
 * A single CPN read runs AFTER the window closes, as a control: it says what
 * CPN believed, without ever having influenced the stored row.
 *
 *   node scripts/live-webhook-attribution.mjs                    # dry run (safe)
 *   CONFIRM=BROADCAST node scripts/live-webhook-attribution.mjs  # irreversible
 *
 * Requires a registered CPN subscription pointing at a publicly reachable
 * `/api/webhooks/circle` — see scripts/live-cpn-subscribe.mjs.
 */
import { createPublicClient, createWalletClient, erc20Abi, fallback, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "@supabase/supabase-js";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { ARC_TESTNET_RPC_FALLBACKS, PERMIT2_ADDRESS, USDC_ADDRESS, arcTestnet } from "../src/constants/arc.ts";
import { createCpnRamp } from "../src/ramp/cpn-ramp.ts";
import { createOrderStore } from "../src/orchestrator/order-store.ts";
import { fromDecimalStringScaled } from "../src/settlement-fx/units.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();

const SOURCE_USDC = process.env.AMOUNT ?? "12";
/** How long to watch the row without touching it. SEPA cash-outs settled in ~16s live. */
const WINDOW_MS = Number(process.env.WINDOW_SECONDS ?? 240) * 1000;
const READ_EVERY_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);

async function main() {
  const env = readEnv();
  const missing = ["CIRCLE_CPN_KEY", "SELLER_PRIVATE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]
    .filter((k) => !env[k]);
  if (missing.length) {
    console.error(`FAILED: missing from .env.local — ${missing.join(", ")}`);
    return 1;
  }

  const signer = privateKeyToAccount(env.SELLER_PRIVATE_KEY);
  const sender = signer.address;
  const store = createOrderStore(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  const pub = createPublicClient({ chain: arcTestnet, transport: fallback(ARC_TESTNET_RPC_FALLBACKS.map((u) => http(u))) });

  // Same EUR/SEPA corridor the demo cashes out through — the one proven live.
  const ramp = createCpnRamp({
    apiKey: env.CIRCLE_CPN_KEY,
    corridor: {
      senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US", destinationCountry: "FR",
      blockchain: "ARC-TESTNET", paymentMethodType: "SEPA", sourceCurrency: "USDC", destinationCurrency: "EUR",
    },
  });

  // ── Endpoint check — without a reachable route, nothing can be proven ─────
  //
  // Listing subscriptions is NOT a reliable precondition: this key answers 403
  // to GET on the subscriptions collection even while its POST creates one. So
  // the check that actually matters is the one Circle itself makes — does the
  // public endpoint answer HEAD with 200.
  const endpoint = process.env.WEBHOOK_URL;
  if (!endpoint) {
    console.error("FAILED: set WEBHOOK_URL to the public https URL registered with Circle.");
    console.error("  WEBHOOK_URL=https://<host>/api/webhooks/circle CONFIRM=BROADCAST node scripts/live-webhook-attribution.mjs");
    return 1;
  }
  const head = await fetch(endpoint, { method: "HEAD" }).catch((e) => ({ status: 0, statusText: e.message }));
  console.log(`Endpoint ${endpoint} → HEAD ${head.status} ${head.statusText ?? ""}`);
  if (head.status !== 200) {
    console.error("FAILED: the endpoint is not reachable — a webhook could not arrive, so nothing would be proven.");
    return 1;
  }

  const bal = await pub.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [sender] });
  console.log(`\nSeller ${sender}  balance ${Number(bal) / 1e6} USDC  cashing out ${SOURCE_USDC}`);

  // ── Quote + prepare + record the row ─────────────────────────────────────
  const address = { street: "1 Rue de Rivoli", city: "Paris", stateProvince: "IDF", country: "FR", postalCode: "75001" };
  const { quote, fees, spreadBps } = await ramp.quote({ sourceAmount: SOURCE_USDC });
  console.log(`QUOTE ${quote.id}: ${quote.sourceAmount.amount} USDC → ${quote.destinationAmount.amount} EUR  (fee ${fees.total.amount}, ${Math.round(spreadBps)}bps)`);

  const { payment, transaction } = await ramp.prepare({
    quote,
    travelRule: [
      { name: "ORIGINATOR_NAME", value: "Rivo Co" },
      { name: "BENEFICIARY_NAME", value: "Acme Co" },
      { name: "ORIGINATOR_ADDRESS", value: { street: "456 Madison Ave", city: "New York", stateProvince: "NY", country: "US", postalCode: "10001" } },
      { name: "BENEFICIARY_ADDRESS", value: address },
      { name: "ORIGINATOR_ACCOUNT_NUMBER", value: "US1234567890" },
      { name: "ORIGINATOR_FINANCIAL_INSTITUTION_NAME", value: "Rivo Bank" },
      { name: "ORIGINATOR_FINANCIAL_INSTITUTION_ADDRESS", value: { street: "456 Madison Ave", city: "New York", stateProvince: "NY", country: "US", postalCode: "10001" } },
    ],
    beneficiaryAccount: [
      { name: "IBAN", value: "FR7630006000011234567890189" },
      { name: "RECIPIENT_LEGAL_NAME", value: "Acme SARL" },
    ],
    senderAddress: sender, refundAddress: sender, useCase: "B2B", reasonForPayment: "PMT001",
    customerRefId: `attrib-${quote.id.slice(0, 8)}`,
  });
  console.log(`PAYMENT ${payment.id} (${payment.status})  |  TX ${transaction.id}`);

  if (process.env.CONFIRM !== "BROADCAST") {
    console.log("\nDRY RUN — nothing recorded, nothing broadcast.");
    console.log("  CONFIRM=BROADCAST node scripts/live-webhook-attribution.mjs");
    return 0;
  }

  await store.recordCpnPayment({
    paymentId: payment.id,
    corridor: "EUR-SEPA",
    senderAddress: sender,
    signedBy: "server",
    sourceMinor: fromDecimalStringScaled(quote.sourceAmount.amount, 6),
    sourceCurrency: quote.sourceAmount.currency,
    destinationMinor: fromDecimalStringScaled(quote.destinationAmount.amount, 2),
    destinationCurrency: quote.destinationAmount.currency,
    status: payment.status ?? "CREATED",
    transactionId: transaction.id,
  });
  const recordedAt = new Date().toISOString();
  console.log(`RECORDED cpn_payments row at ${payment.status ?? "CREATED"}`);

  // ── Permit2 allowance (a broadcast without it fails on chain) ────────────
  const permitAmount = BigInt(transaction.messageToBeSigned.message?.permitted?.amount ?? 0);
  const allowance = await pub.readContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [sender, PERMIT2_ADDRESS],
  });
  if (allowance < permitAmount) {
    console.log(`Allowance ${Number(allowance) / 1e6} < ${Number(permitAmount) / 1e6} — approving Permit2…`);
    const wallet = createWalletClient({ account: signer, chain: arcTestnet, transport: fallback(ARC_TESTNET_RPC_FALLBACKS.map((u) => http(u))) });
    const hash = await wallet.writeContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, permitAmount],
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  approved ${hash}`);
  }

  // ── BROADCAST — point of no return ───────────────────────────────────────
  console.log("\n⚠️  BROADCAST — the seller's USDC leaves irreversibly.");
  const submitted = await ramp.submit({ paymentId: payment.id, transaction }, signer);
  const broadcastAt = new Date().toISOString();
  console.log(`SUBMITTED tx ${submitted.id}: ${submitted.status}  at ${stamp()}`);

  // ── Observation window — READ ONLY. Nothing below writes anything. ───────
  console.log(`\nWatching for ${WINDOW_MS / 1000}s. This process writes NOTHING from here on.`);
  const seenStatus = [];
  const seenEvents = new Set();
  let last = null;
  const until = Date.now() + WINDOW_MS;
  let terminal = false;

  while (Date.now() < until) {
    await sleep(READ_EVERY_MS);

    const row = await store.getCpnPayment(payment.id);
    if (row && row.status !== last) {
      console.log(`  ${stamp()}  cpn_payments: ${last ?? "—"} → ${row.status}`);
      seenStatus.push({ at: new Date().toISOString(), status: row.status });
      last = row.status;
    }

    // `events` is written by the webhook route and by nothing else.
    const { data: evs } = await db
      .from("events").select("type, received_at, sig_verified")
      .gte("received_at", recordedAt).order("received_at", { ascending: true });
    for (const e of evs ?? []) {
      const key = `${e.received_at}|${e.type}`;
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      console.log(`  ${stamp()}  webhook event: ${e.type}  sig_verified=${e.sig_verified}`);
    }

    if (last === "COMPLETED" || last === "FAILED") { terminal = true; break; }
  }

  // ── Control read — first and only CPN status call, after the window ──────
  const control = await ramp.status(payment.id);

  console.log("\n─── RESULT ────────────────────────────────────────────────");
  console.log(`payment          ${payment.id}`);
  console.log(`broadcast at     ${broadcastAt}`);
  console.log(`stored status    ${last ?? "(unchanged)"}${terminal ? " (terminal)" : ""}`);
  console.log(`CPN status       ${control.status}   ← read once, after the window`);
  console.log(`webhook events   ${seenEvents.size} row(s) in \`events\``);
  console.log(`store writes by this process: 1 (the initial recordCpnPayment) — zero status writes`);
  if (seenStatus.length && seenEvents.size) {
    console.log("\nATTRIBUTED: the row advanced while the only writer able to touch it was the webhook route.");
  } else if (seenEvents.size && !seenStatus.length) {
    console.log("\nINCONCLUSIVE: webhooks arrived but the row never moved — check the reducer / payment id match.");
  } else if (!seenEvents.size) {
    console.log("\nINCONCLUSIVE: no webhook reached the route (tunnel down, subscription disabled, or nothing fired).");
  }
  return 0;
}

process.exitCode = await main();
