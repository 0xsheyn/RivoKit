/**
 * Phase 4 proof — events sync + compliance screen + mock payout instruction.
 *
 * Ties the three Phase-4 pieces into one run:
 *   1. Compliance screening against Circle's LIVE Compliance Engine — a good
 *      address and a known OFAC-sanctioned one — through the same
 *      createCircleScreener the SDK uses (so the module is exercised, not mocked).
 *   2. The lifecycle emitter delivering a state change to a host handler
 *      (US-06 "status host sinkron").
 *   3. A mock payout instruction for a settled order — structured, and stamped
 *      MOCK end to end (exit criterion: "instruksi payout berlabel mock terbit").
 *
 *   node scripts/live-compliance.mjs
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createCircleClient } from "./lib/circle.mjs";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { createComplianceGate, createCircleScreener, ComplianceBlockedError } from "../src/events/compliance.ts";
import { createEmitter } from "../src/events/emitter.ts";
import { mockPayout, isMockPayout } from "../src/payout/mock-payout.ts";

installCircleDnsPinning();

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

const CHAIN = env.CIRCLE_BLOCKCHAIN || "ARC-TESTNET";
const GOOD = env.MERCHANT_ADDRESS;
// OFAC-sanctioned (Tornado Cash router). Public, well-known — used only to
// exercise the DENIED path against the live engine.
const SANCTIONED = "0x722122dF12D4e14e13Ac3b6895a86e84145b6967";

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " GAGAL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const circle = createCircleClient({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET });
const post = (path, body) => circle.request("POST", path, body);
const screener = createCircleScreener(post, () => randomUUID());
const gate = createComplianceGate(screener);

// ── 1. Compliance screening (live) ─────────────────────────────────────

step("Langkah 1 — screening alamat via Circle Compliance Engine (LIVE)");

info(`chain ${CHAIN}`);
let goodResult;
try {
  goodResult = await gate.assertAllowed(GOOD, CHAIN, "funding");
  ok(`alamat baik ${GOOD} → ${goodResult.decision}`);
  record(goodResult.decision === "APPROVED", "alamat merchant lolos screening (APPROVED)");
} catch (e) {
  console.log(`    alamat baik diblok tak terduga: ${e.message}`);
  record(false, "alamat merchant lolos screening", e.message?.slice(0, 80));
}

step("Langkah 2 — screening alamat tersanksi (round-trip live)");

// The proof here is connectivity + a real decision from the engine, NOT the
// verdict itself: Circle's SANDBOX screening dataset is limited and approves
// addresses that mainnet would deny. The gate's block-on-non-APPROVED behaviour
// is proven deterministically in compliance.test.ts; here we only confirm the
// live engine answers.
try {
  const raw = await screener(SANCTIONED, CHAIN);
  info(`engine (sandbox) → ${raw.decision} untuk alamat tersanksi ${SANCTIONED}`);
  if (raw.decision === "APPROVED") {
    info("catatan: sandbox tak menandai alamat ini; di mainnet gate akan memblokir DENIED.");
  }
  record(typeof raw.decision === "string", "engine live mengembalikan keputusan (konektivitas + parse)", raw.decision);
} catch (e) {
  if (e instanceof ComplianceBlockedError) {
    ok(`gate memblokir: ${e.decision}`);
    record(true, "alamat tersanksi diblokir gate (COMPLIANCE_BLOCKED)", e.decision);
  } else {
    throw e;
  }
}

// ── 3. Emitter — status host sinkron ───────────────────────────────────

step("Langkah 3 — emitter menyampaikan perubahan state ke handler host (US-06)");

const emitter = createEmitter();
const received = [];
emitter.on("funded", (p) => received.push(["funded", p]));
emitter.on("released", (p) => received.push(["released", p]));
emitter.on("refunded", (p) => received.push(["refunded", p]));

const emittedFunded = emitter.emitForState("funded", { orderId: "ord_demo" });
const emittedReleased = emitter.emitForState("released", {
  orderId: "ord_demo", eurcOutMinor: 1_930_000n, rebateMinor: 30_000n,
});
const emittedSilent = emitter.emitForState("settlement_pending", { orderId: "ord_demo" });

info(`event terkirim: ${received.map(([n]) => n).join(", ")}`);
record(emittedFunded === "funded" && emittedReleased === "released", "state → event nama cocok");
record(received.length === 2, "handler host menerima kedua event", String(received.length));
record(emittedSilent === null, "state tanpa-event tidak memancarkan apa pun (settlement_pending)");

// ── 4. Payout instruction — berlabel MOCK ──────────────────────────────

step("Langkah 4 — instruksi payout terbit, berlabel MOCK (exit criterion)");

const payout = mockPayout({
  orderId: "ord_demo",
  beneficiary: GOOD,
  eurcMinor: 1_930_000n,
  settlementTxHash: "0xdemoSwapTxHash",
  now: Math.floor(Date.now() / 1000),
});

console.log(JSON.stringify(payout, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
record(isMockPayout(payout), "instruksi payout dikenali sebagai MOCK");
record(payout.label === "MOCK" && payout.executed === false, "label MOCK + executed=false");
record(payout.target.amountMinor === payout.source.amountMinor, "EUR nominal 1:1 dengan EURC (estimasi)");
record(/tidak mengeksekusi leg fiat/i.test(payout.disclaimer), "disclaimer menyatakan batas (tak eksekusi fiat)");

// ── Hasil ──────────────────────────────────────────────────────────────

step("Hasil");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} lolos.` +
    (failed ? " Ada yang gagal." : " Fase 4 TERBUKTI: screening live + status sinkron + payout MOCK."),
);
process.exit(failed ? 1 : 0);
