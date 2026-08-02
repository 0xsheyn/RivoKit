/**
 * The browser funding rails, executed on-chain for the first time.
 *
 * WHAT WAS ACTUALLY UNPROVEN
 *
 * Not the rails. Gateway spend and the CCTP bridge were both proven months ago
 * by `live-unified.mjs` and `live-funding.mjs`. What had never run is the
 * ADAPTER those scripts do not use: they build App Kit's adapter with
 * `createViemAdapterFromPrivateKey`, while `demo/app/wallet-rails.ts` — the
 * code a connected wallet runs — builds it with
 * `createViemAdapterFromProvider`. Different path, different chain-selection
 * and signing logic, never executed.
 *
 * WHAT RUNNING IT FOUND
 *
 * A bug, on the first attempt. The proven scripts pass TWO adapters, one per
 * chain; `walletSpendToArc` and `walletBridgeToArc` passed ONE, because a
 * browser wallet is a single object. `createViemAdapterFromProvider` takes no
 * chain argument and derives it from the provider, so App Kit sent the
 * destination transaction on the SOURCE chain:
 *
 *   The current chain of the wallet (id: 11155111) does not match the target
 *   chain for the transaction (id: 5042002 – Arc Testnet)
 *
 * It failed AFTER the burn had landed — 2 USDC left the Gateway balance and sat
 * in flight until `scripts/live-gateway-recover.mjs` minted it with the
 * attestation the failure produced. The fix is `pinnedTo` in wallet-rails.ts:
 * two chain-scoped views of one wallet, each switching the wallet before it
 * signs. That is what a real browser must do too — you cannot sign an Arc
 * transaction from a wallet showing the source chain.
 *
 * So this imports the demo's functions directly — it does not reimplement them
 * — and drives them through an EIP-1193 provider backed by the buyer's key
 * (`scripts/lib/eip1193.mjs`). That proves the interface a browser wallet
 * exposes, not MetaMask's own UI.
 *
 * SAFETY: both rails move the buyer's USDC to the buyer's OWN address on Arc.
 * Nothing leaves the payer's control and nothing is paid to anyone. The bridge
 * is still slow and interruptible, so it sits behind --yes.
 *
 *   node scripts/live-wallet-rails.mjs             # read-only: balances + plan
 *   node scripts/live-wallet-rails.mjs --yes       # run both rails
 *   node scripts/live-wallet-rails.mjs --yes --spend-only
 *   node scripts/live-wallet-rails.mjs --yes --bridge-only
 */
import { createPublicClient, erc20Abi, formatUnits, http, parseUnits } from "viem";
import { arcTestnet, avalancheFuji } from "viem/chains";
import { arcTransport } from "../src/lib/rpc.ts";
import { USDC_ADDRESS } from "../src/constants/arc.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import {
  SOURCE_USDC,
  resetWalletRails,
  walletBridgeToArc,
  walletGatewayBalance,
  walletSpendToArc,
} from "../demo/app/wallet-rails.ts";
import { createLocalEip1193Provider } from "./lib/eip1193.mjs";
import { readEnv } from "./lib/env.mjs";

// Gateway's API is on circle.com like everything else, and this network
// hijacks all of it. Without pinning the balance read fails as "fetch failed"
// after ten retries, which reads like an outage.
installCircleDnsPinning();

const env = readEnv();

const CONFIRMED = process.argv.includes("--yes");
const SPEND_ONLY = process.argv.includes("--spend-only");
const BRIDGE_ONLY = process.argv.includes("--bridge-only");

/** Small on purpose: this proves a code path, it does not need size. */
const SPEND = parseUnits("2", 6);
const BRIDGE = parseUnits("3", 6);

const sep = createPublicClient({ chain: avalancheFuji, transport: http() });
const arc = createPublicClient({ chain: arcTestnet, transport: arcTransport() });

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const fmt = (v) => formatUnits(BigInt(v ?? 0), 6);

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// ── The "wallet" ───────────────────────────────────────────────────────

const provider = createLocalEip1193Provider(env.BUYER_PRIVATE_KEY);
// The demo caches one adapter per provider instance; start clean so this run
// builds its own rather than inheriting anything.
resetWalletRails();

const arcUsdc = () => arc.readContract({
  address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [provider.address],
});
const srcUsdc = () => sep.readContract({
  address: SOURCE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [provider.address],
});

step("Step 0 — the connected wallet");
info(`address ${provider.address} · starts on chain ${provider.chainId} (the source chain)`);

const arcBefore = await arcUsdc();
const srcBefore = await srcUsdc();
info(`Arc USDC ${fmt(arcBefore)} · source USDC ${fmt(srcBefore)}`);

// ── 1. Gateway balance, read through the provider adapter ──────────────

step("Step 1 — walletGatewayBalance (first call through createViemAdapterFromProvider)");
const bal = await walletGatewayBalance(provider);
info(`confirmed ${fmt(bal.confirmedMinor)} · pending ${fmt(bal.pendingMinor)}`);
record(true, "the provider-backed adapter builds and reads Gateway");
info(`App Kit asked for: ${[...new Set(provider.calls)].join(", ")}`);

const canSpend = BigInt(bal.confirmedMinor) >= SPEND;
const canBridge = srcBefore >= BRIDGE;
// Only judge the precondition for a rail this run will actually attempt.
// Recording both made --bridge-only report a failure about a Gateway balance
// it was never going to touch.
if (!BRIDGE_ONLY) record(canSpend, `Gateway has ${fmt(SPEND)} confirmed to spend`, fmt(bal.confirmedMinor));
if (!SPEND_ONLY) record(canBridge, `the source chain has ${fmt(BRIDGE)} USDC to bridge`, fmt(srcBefore));

if (!CONFIRMED) {
  console.log(
    `\n  Read-only so far. Running with --yes would:\n` +
      (BRIDGE_ONLY ? "" : `    · spend  ${fmt(SPEND)} USDC from Gateway → ${provider.address} on Arc\n`) +
      (SPEND_ONLY ? "" : `    · bridge ${fmt(BRIDGE)} USDC the source chain → Arc (CCTP, minutes, interruptible)\n`) +
      `  Both land in the buyer's OWN Arc address; nothing is paid to anyone.\n\n` +
      `  node scripts/live-wallet-rails.mjs --yes\n`,
  );
  process.exit(0);
}

// ── 2. Gateway spend → Arc ─────────────────────────────────────────────

let afterSpend = arcBefore;
if (!BRIDGE_ONLY) {
  step("Step 2 — walletSpendToArc (two chain-pinned views of ONE wallet)");
  if (!canSpend) {
    record(false, "Gateway spend executed", "not enough confirmed balance");
  } else {
    const before = provider.calls.length;
    const txHash = await walletSpendToArc(provider, { amountMinor: SPEND, recipient: provider.address });
    ok(`spend tx ${txHash}`);
    info(`wallet was asked for ${provider.calls.length - before} more calls; now on chain ${provider.chainId}`);

    // The balance is the proof; the returned hash is only a claim about it.
    for (let i = 0; i < 20 && afterSpend === arcBefore; i++) {
      afterSpend = await arcUsdc();
      if (afterSpend !== arcBefore) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const credited = afterSpend - arcBefore;
    const mintFee = SPEND - credited;
    info(`Arc USDC ${fmt(arcBefore)} → ${fmt(afterSpend)}`);
    record(Boolean(txHash), "Gateway spend executed through the provider adapter", txHash);
    // Gateway takes a fee on the mint, so the credit is deliberately NOT exact.
    // Asserting equality here failed once and the assertion was wrong, not the
    // rail — so measure the fee instead of pretending it does not exist. The
    // bound is loose enough to survive a fee change and tight enough that a
    // genuinely short mint still fails.
    record(
      credited > 0n && mintFee >= 0n && mintFee < SPEND / 100n,
      "Arc credited the spend, less Gateway's mint fee",
      `credited ${fmt(credited)} · fee ${fmt(mintFee)}`,
    );
    record(
      provider.calls.includes("wallet_switchEthereumChain"),
      "the wallet was asked to switch chains before the mint",
      `now on ${provider.chainId}`,
    );
  }
}

// ── 3. CCTP bridge the source chain → Arc ───────────────────────────────────────

if (!SPEND_ONLY) {
  step("Step 3 — walletBridgeToArc (CCTP, burn on the the source chain view, mint on the Arc view)");
  if (!canBridge) {
    record(false, "CCTP bridge executed", "not enough source USDC");
  } else {
    info("burn on the source chain → attestation → mint on Arc. Minutes, not seconds.");
    const before = provider.calls.length;
    try {
      const mintTx = await walletBridgeToArc(provider, BRIDGE);
      ok(`mint tx ${mintTx}`);
      info(`wallet was asked for ${provider.calls.length - before} more calls`);

      const arcAfter = await arcUsdc();
      const srcAfter = await srcUsdc();
      info(`Arc USDC ${fmt(afterSpend)} → ${fmt(arcAfter)} · the source chain ${fmt(srcBefore)} → ${fmt(srcAfter)}`);
      record(Boolean(mintTx), "CCTP bridge executed through the provider adapter", mintTx);
      // The burn side IS exact — CCTP takes its fee out of the mint, not the
      // burn — so this one is worth asserting to the unit.
      record(srcBefore - srcAfter === BRIDGE, "the source chain balance fell by exactly the bridged amount",
        `${fmt(srcBefore - srcAfter)} vs ${fmt(BRIDGE)}`);
      const minted = arcAfter - afterSpend;
      record(minted > 0n && BRIDGE - minted < BRIDGE / 100n, "Arc credited the bridge, less the mint fee",
        `credited ${fmt(minted)} · fee ${fmt(BRIDGE - minted)}`);
      record(provider.calls.includes("wallet_switchEthereumChain"),
        "the wallet was asked to switch chains before the mint", `now on ${provider.chainId}`);
    } catch (e) {
      // A stuck bridge means the burn LANDED and the funds are in flight. That
      // is recoverable, and saying "failed" would invite a resend that burns
      // twice — the one mistake this path must not make.
      const msg = String(e?.message ?? e);
      record(false, "CCTP bridge executed through the provider adapter", msg.slice(0, 220));
      if (/stuck|attestation/i.test(msg)) {
        info("The burn already happened — funds are in flight. RESUME, never resend.");
      }
    }
  }
}

// ── Result ─────────────────────────────────────────────────────────────

step("Result");
info(`distinct wallet methods exercised: ${[...new Set(provider.calls)].join(", ")}`);
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed
      ? " Something failed."
      : " The browser rails run on-chain through a provider-backed adapter."),
);
process.exit(failed ? 1 : 0);
