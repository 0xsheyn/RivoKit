/**
 * Resume a Gateway spend whose burn landed but whose mint did not.
 *
 * WHY THIS IS A RESUME AND NOT A RETRY
 *
 * A Gateway spend is two steps against two chains: the balance is burned and
 * attested, then minted on the destination. When the mint fails — a wrong chain,
 * a dropped RPC, a closed laptop — the burn has ALREADY happened. The balance is
 * gone from Gateway and the funds exist only as an attestation waiting to be
 * redeemed. Re-running the spend would burn a second time; App Kit says as much
 * by marking the error `RESUMABLE` rather than failed.
 *
 * So this takes the attestation and signature the failed attempt produced and
 * does only the missing half: `gatewayMint` on Arc. The attestation is
 * single-use and bound to its recipient, so this cannot mint to anyone else and
 * cannot mint twice.
 *
 * It SIMULATES before it sends. A malformed or already-redeemed attestation
 * then costs nothing and says so plainly, instead of burning gas on a revert.
 *
 *   node scripts/live-gateway-recover.mjs .recovery/gateway-stuck.json
 *   node scripts/live-gateway-recover.mjs .recovery/gateway-stuck.json --yes
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { arcTransport } from "../src/lib/rpc.ts";
import { GATEWAY_MINTER_ADDRESS, USDC_ADDRESS } from "../src/constants/arc.ts";
import { readEnv } from "./lib/env.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/live-gateway-recover.mjs <stuck.json> [--yes]");
  process.exit(1);
}
const CONFIRMED = process.argv.includes("--yes");

const env = readEnv();
const account = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: arcTestnet, transport: arcTransport() });

const { attestation, signature } = JSON.parse(readFileSync(file, "utf8"));

const MINTER_ABI = [
  {
    type: "function",
    name: "gatewayMint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
];

const step = (m) => console.log(`\n▸ ${m}`);
const info = (m) => console.log(`    ${m}`);
const fmt = (v) => formatUnits(v, 6);

step("Step 0 — what we are holding");
info(`recipient ${account.address}`);
info(`attestation ${(attestation.length - 2) / 2} bytes · signature ${(signature.length - 2) / 2} bytes`);

// The selector the failed transaction used, recomputed rather than trusted:
// if this does not match, the ABI below is not the function that was called.
const selector = toFunctionSelector("gatewayMint(bytes,bytes)");
info(`gatewayMint selector ${selector} (failed tx used 0x9fb01cc5)`);
if (selector !== "0x9fb01cc5") {
  console.error("Selector mismatch — this is not the function the spend tried to call. Stopping.");
  process.exit(1);
}

const before = await pub.readContract({
  address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
});
info(`Arc USDC before ${fmt(before)}`);

// ── Simulate ───────────────────────────────────────────────────────────

step("Step 1 — simulate the mint (costs nothing, proves the attestation)");
try {
  await pub.simulateContract({
    account,
    address: GATEWAY_MINTER_ADDRESS,
    abi: MINTER_ABI,
    functionName: "gatewayMint",
    args: [attestation, signature],
  });
  info("simulation succeeded — the attestation is valid and unredeemed");
} catch (e) {
  const msg = String(e?.shortMessage ?? e?.message ?? e);
  console.error(`\n  Simulation FAILED: ${msg.slice(0, 400)}`);
  console.error(
    "\n  If this says the attestation was already used, the mint landed after all —\n" +
      "  check the Arc balance before doing anything else. Do NOT re-run the spend.",
  );
  process.exit(1);
}

if (!CONFIRMED) {
  console.log(`\n  Simulation only. Re-run with --yes to send the mint.\n`);
  process.exit(0);
}

// ── Send ───────────────────────────────────────────────────────────────

step("Step 2 — mint on Arc");
const wallet = createWalletClient({ account, chain: arcTestnet, transport: arcTransport() });
const hash = await wallet.writeContract({
  address: GATEWAY_MINTER_ADDRESS,
  abi: MINTER_ABI,
  functionName: "gatewayMint",
  args: [attestation, signature],
});
info(`tx ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
info(`status ${receipt.status}`);

const after = await pub.readContract({
  address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
});

step("Result");
info(`Arc USDC ${fmt(before)} → ${fmt(after)} (+${fmt(after - before)})`);
console.log(
  receipt.status === "success" && after > before
    ? "\nRecovered. The in-flight balance is now on Arc."
    : "\nThe mint did not credit anything — investigate before re-running.",
);
process.exit(receipt.status === "success" && after > before ? 0 : 1);
