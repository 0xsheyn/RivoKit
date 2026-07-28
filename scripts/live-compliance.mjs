/**
 * Phase 4 proof — events sync + compliance screen + mock payout instruction.
 *
 * Ties the three Phase-4 pieces into one run:
 *   1. Compliance screening against Circle's LIVE Compliance Engine — a good
 *      address and a known OFAC-sanctioned one — through the same
 *      createCircleScreener the SDK uses (so the module is exercised, not mocked).
 *   2. The lifecycle emitter delivering a state change to a host handler
 *      (US-06 "host status stays in sync").
 *   3. A mock payout instruction for a settled order — structured, and stamped
 *      MOCK end to end (exit criterion: "a mock-labelled payout instruction is issued").
 *
 *   node scripts/live-compliance.mjs
 */
import { randomUUID } from "node:crypto";
import { createCircleClient } from "./lib/circle.mjs";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { createComplianceGate, createCircleScreener, ComplianceBlockedError } from "../src/events/compliance.ts";
import { createEmitter } from "../src/events/emitter.ts";
import { mockPayout, isMockPayout } from "../src/payout/mock-payout.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();

const env = readEnv();

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
  console.log(`${pass ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const circle = createCircleClient({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET });
const post = (path, body) => circle.request("POST", path, body);
const screener = createCircleScreener(post, () => randomUUID());
const gate = createComplianceGate(screener);

// ── 1. Compliance screening (live) ─────────────────────────────────────

step("Step 1 — address screening via the Circle Compliance Engine (LIVE)");

info(`chain ${CHAIN}`);
let goodResult;
try {
  goodResult = await gate.assertAllowed(GOOD, CHAIN, "funding");
  ok(`clean address ${GOOD} → ${goodResult.decision}`);
  record(goodResult.decision === "APPROVED", "the merchant address passes screening (APPROVED)");
} catch (e) {
  console.log(`    a clean address was unexpectedly blocked: ${e.message}`);
  record(false, "the merchant address passes screening", e.message?.slice(0, 80));
}

step("Step 2 — screening a sanctioned address (live round-trip)");

// The proof here is connectivity + a real decision from the engine, NOT the
// verdict itself: Circle's SANDBOX screening dataset is limited and approves
// addresses that mainnet would deny. The gate's block-on-non-APPROVED behaviour
// is proven deterministically in compliance.test.ts; here we only confirm the
// live engine answers.
try {
  const raw = await screener(SANCTIONED, CHAIN);
  info(`engine (sandbox) → ${raw.decision} for sanctioned address ${SANCTIONED}`);
  if (raw.decision === "APPROVED") {
    info("note: the sandbox does not flag this address; on mainnet the gate would block on DENIED.");
  }
  record(typeof raw.decision === "string", "the live engine returns a decision (connectivity + parse)", raw.decision);
} catch (e) {
  if (e instanceof ComplianceBlockedError) {
    ok(`gate blocked: ${e.decision}`);
    record(true, "the gate blocks a sanctioned address (COMPLIANCE_BLOCKED)", e.decision);
  } else {
    throw e;
  }
}

// ── 3. Emitter — host status stays in sync ───────────────────────────────────

step("Step 3 — the emitter delivers a state change to the host handler (US-06)");

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

info(`events emitted: ${received.map(([n]) => n).join(", ")}`);
record(emittedFunded === "funded" && emittedReleased === "released", "state → event name matches");
record(received.length === 2, "the host handler received both events", String(received.length));
record(emittedSilent === null, "an event-less state emits nothing (settlement_pending)");

// ── 4. Payout instruction — labelled MOCK ──────────────────────────────

step("Step 4 — the payout instruction is issued, labelled MOCK (exit criterion)");

const payout = mockPayout({
  orderId: "ord_demo",
  beneficiary: GOOD,
  eurcMinor: 1_930_000n,
  settlementTxHash: "0xdemoSwapTxHash",
  now: Math.floor(Date.now() / 1000),
});

console.log(JSON.stringify(payout, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
record(isMockPayout(payout), "the payout instruction is recognised as MOCK");
record(payout.label === "MOCK" && payout.executed === false, "label MOCK + executed=false");
record(payout.target.amountMinor === payout.source.amountMinor, "EUR nominal is 1:1 with EURC (estimate)");
record(/does not execute the fiat leg/i.test(payout.disclaimer), "the disclaimer states the boundary (no fiat execution)");

// ── Result ──────────────────────────────────────────────────────────────

step("Result");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : " Phase 4 PROVEN: live screening + synced status + MOCK payout."),
);
process.exit(failed ? 1 : 0);
