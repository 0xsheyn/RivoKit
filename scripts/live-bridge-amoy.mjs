/**
 * Cross-chain USDC, live: Polygon Amoy → Arc Testnet.
 *
 * This is the FUNDING direction — the one that matters for Amoy as a source
 * chain. `scripts/live-bridge.mjs` proves the opposite direction on a different
 * chain (Arc → Ethereum Sepolia) and proves nothing about this rail.
 *
 * Two things differ from every other source chain here, and both are gas:
 *
 *   - Approve and burn happen on Amoy and cost **POL**, not USDC. Arc is the
 *     odd one out in this repo (USDC is its native token); Amoy is normal.
 *   - Mint happens on Arc and costs USDC-as-gas.
 *
 * So the run needs POL on Amoy AND USDC on Arc, and Step 1 refuses to continue
 * without both rather than failing halfway with the burn already landed.
 *
 * CCTP is burn → attest → mint, and attestation is off-chain. Amoy's v2
 * fastConfirmations is 13 (~2s blocks), so expect tens of seconds on the fast
 * path and ~1-2 min if the Fast Transfer Allowance is spent.
 *
 * State is recorded so an interruption can be CONTINUED, never restarted:
 * re-burning would move a second amount rather than recover the first.
 *
 *   node scripts/live-bridge-amoy.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, createWalletClient, erc20Abi, fallback, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, polygonAmoy } from "viem/chains";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { USDC_ADDRESS } from "../src/constants/arc.ts";
import { createBridge, BridgeStuckError } from "../src/funding/bridge.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { sourceChain } from "../demo/lib/source-chain.ts";
import { readEnv } from "./lib/env.mjs";
import { stateFile } from "./lib/state.mjs";

// This network hijacks Circle's DNS (observed live, not hypothetical); pin the real
// IPs before any SDK call. Must run before AppKit is used.
installCircleDnsPinning();

const STATE_FILE = stateFile("live-bridge-amoy");
const AMOUNT = parseUnits("3", 6);

const AMOY = sourceChain("amoy");

const env = readEnv();

const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
const arcClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
// Never viem's default transport for Amoy: that is rpc-amoy.polygon.technology,
// which does not resolve on this network at all (ENOTFOUND, 2026-08-02). The
// table's own list is ordered to put the endpoints that DO answer first.
const amoyClient = createPublicClient({
  chain: polygonAmoy,
  transport: fallback(AMOY.rpcUrls.map((url) => http(url))),
});

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const fmt = (v) => formatUnits(v, 6);

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
};

if (process.argv.includes("--reset") && existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const arcUsdc = async () => {
  await sleep(250);
  return arcClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] });
};
const amoyUsdc = () =>
  amoyClient.readContract({ address: AMOY.usdc, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] });

const kit = new AppKit();

// A CCTP transfer reports progress only through events. Without this the run
// looks frozen, and a stall is indistinguishable from slowness — which matters,
// because the two need opposite responses (wait vs. resume).
kit.on("*", (evt) => {
  const v = evt?.values;
  if (v?.name) info(`  [${v.name}] ${v.state}${v.txHash ? ` ${v.txHash}` : ""}`);
});

const bridge = createBridge(kit);

// The adapter does NOT use the clients above — it builds its own from Circle's
// chain table, whose Amoy endpoint is the one that does not resolve here. Left
// alone it dies in App Kit's pre-flight balance read, before any burn:
//
//   Read contract failed: HTTP request failed. URL: https://rpc-amoy.polygon.technology/
//
// `getPublicClient` / `getWalletClient` exist for exactly this. Both must be
// overridden: the read path and the signing path build separate clients, so
// fixing only one still leaves the burn broadcasting through a dead endpoint.
const amoyTransport = () => fallback(AMOY.rpcUrls.map((url) => http(url)));

const amoyAdapter = createViemAdapterFromPrivateKey({
  privateKey: env.BUYER_PRIVATE_KEY,
  chain: BridgeChain.Polygon_Amoy_Testnet,
  getPublicClient: ({ chain }) =>
    createPublicClient({ chain, transport: chain.id === polygonAmoy.id ? amoyTransport() : http() }),
  getWalletClient: ({ chain, account }) =>
    createWalletClient({ chain, account, transport: chain.id === polygonAmoy.id ? amoyTransport() : http() }),
});
const arcAdapter = createViemAdapterFromPrivateKey({
  privateKey: env.BUYER_PRIVATE_KEY,
  chain: BridgeChain.Arc_Testnet,
});

const params = {
  fromAdapter: amoyAdapter,
  fromChain: BridgeChain.Polygon_Amoy_Testnet,
  toAdapter: arcAdapter,
  toChain: BridgeChain.Arc_Testnet,
  amountMinor: AMOUNT,
  kitKey: env.KIT_KEY,
};

// ── Opening balances ─────────────────────────────────────────────────────────

step("Step 1 — opening balances on both chains");

const beforeAmoy = await amoyUsdc();
const beforeArc = await arcUsdc();
const amoyPol = await amoyClient.getBalance({ address: buyer.address });

info(`Amoy ${fmt(beforeAmoy)} USDC · ${formatUnits(amoyPol, 18)} POL`);
info(`Arc  ${fmt(beforeArc)} USDC (also its gas token)`);

record(beforeAmoy >= AMOUNT, "Amoy holds enough USDC to bridge", fmt(beforeAmoy));
record(amoyPol > 0n, "Amoy holds POL for approve + burn gas", formatUnits(amoyPol, 18));
record(beforeArc > 0n, "Arc holds USDC for mint gas", fmt(beforeArc));

// Bail BEFORE burning rather than stranding funds mid-flight: a burn with no gas
// to mint on the far side is exactly the in-flight state this repo treats as the
// expensive failure. Skipped once the burn is already recorded — at that point
// the funds are out and resuming is the only correct move.
if (!state.bridgeDone && checks.some((c) => !c)) {
  step("Result");
  console.log("Prerequisites unmet — refusing to burn. Nothing moved.");
  process.exit(1);
}

// ── Estimate ─────────────────────────────────────────────────────────────────

step("Step 2 — estimate bridge Amoy → Arc");

const est = await bridge.estimate(params);
info(`${est.amount} ${est.token}: ${est.sourceChain} → ${est.destinationChain}`);
for (const f of est.gasFees) info(`  gas ${f.name}: ${f.token} on ${f.blockchain}`);
record(
  est.sourceChain === "Polygon_Amoy_Testnet" && est.destinationChain === "Arc_Testnet",
  "estimate direction is correct",
);

// ── Execute ──────────────────────────────────────────────────────────────────

step("Step 3 — execute bridge (CCTP: burn → attestation → mint)");
info("fast path is ~13 Amoy blocks; a spent Fast Transfer Allowance makes it 33");

if (!state.bridgeDone) {
  // Gated like `live-bridge`, on the first attempt only. The burn here reverts
  // every time — that failure IS the finding — but the approve ahead of it does
  // land, and "it was going to fail anyway" is a poor reason to be the one
  // bridge script that spends without asking.
  if (!state.startedAt && process.env.CONFIRM !== "BRIDGE") {
    console.error(
      "\nThis approves USDC on Amoy and attempts a CCTP burn (which reverts — that\n" +
        "is what this script documents). To go ahead:\n" +
        "  CONFIRM=BRIDGE node scripts/live-bridge-amoy.mjs\n",
    );
    process.exit(1);
  }
  state.startedAt ??= new Date().toISOString();
  save();
  const t0 = Date.now();
  try {
    const res = await bridge.execute(params);
    state.bridgeDone = res.state === "success";
    state.result = { state: res.state, burn: res.burnTxHash, mint: res.mintTxHash };
    save();
    ok(`bridge completed in ${Math.round((Date.now() - t0) / 1000)}s — state ${res.state}`);
    info(`burn (Amoy) ${res.burnTxHash ?? "-"}`);
    info(`mint (Arc)  ${res.mintTxHash ?? "-"}`);
    record(res.state === "success", "bridge state is success", res.state);
    record(Boolean(res.burnTxHash), "burn recorded on the origin chain");
    record(Boolean(res.mintTxHash), "mint recorded on the destination chain");
  } catch (e) {
    if (e instanceof BridgeStuckError) {
      console.log(`\n  STUCK — ${e.message}`);
      console.log("  Re-run this script to continue; DO NOT reset.");
      process.exit(1);
    }
    throw e;
  }
} else {
  ok("bridge already completed in an earlier run");
  info(`burn (Amoy) ${state.result?.burn ?? "-"}`);
  info(`mint (Arc)  ${state.result?.mint ?? "-"}`);
}

// ── Verification ─────────────────────────────────────────────────────────────

step("Step 4 — verify both chains");

await sleep(5000);
const afterAmoy = await amoyUsdc();
const afterArc = await arcUsdc();

info(`Amoy ${fmt(beforeAmoy)} → ${fmt(afterAmoy)}  (${fmt(afterAmoy - beforeAmoy)})`);
info(`Arc  ${fmt(beforeArc)} → ${fmt(afterArc)}  (+${fmt(afterArc - beforeArc)})`);

// Only meaningful when this run did the moving. On a resumed run the balances
// already reflect the transfer, and asserting a delta would report a healthy
// rail as broken — the exact false failure live-bridge.mjs produces.
if (state.movedThisRun !== false && !state.verifiedAt) {
  const amoySpent = beforeAmoy - afterAmoy;
  const arcGain = afterArc - beforeArc;
  record(amoySpent >= AMOUNT, "USDC left Amoy", fmt(amoySpent));
  record(arcGain > 0n, "USDC arrived on Arc", fmt(arcGain));
  // Arc's balance also pays mint gas, so the credit can land slightly under the
  // amount sent; it must never land over it.
  record(arcGain <= AMOUNT, "what arrived does not exceed what was sent", `${fmt(arcGain)} <= ${fmt(AMOUNT)}`);
  state.verifiedAt = new Date().toISOString();
  save();
} else {
  info("balances already reflect an earlier run — delta assertions skipped");
}

step("Result");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : " Cross-chain funding PROVEN: Polygon Amoy → Arc."),
);
process.exit(failed ? 1 : 0);
