/**
 * Revoke the buyer's Permit2 USDC allowance (set it back to 0) on Arc.
 *
 * Housekeeping after the broadcast test — leaves no standing approval. Rotates
 * through the Arc RPC fallbacks because the public endpoint rate-limits.
 *
 *   node scripts/live-ramp-revoke.mjs
 */
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_RPC_FALLBACKS, PERMIT2_ADDRESS, USDC_ADDRESS, arcTestnet } from "../src/constants/arc.ts";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();
const account = privateKeyToAccount(env.BUYER_PRIVATE_KEY);

async function withRpc(fn) {
  for (const url of ARC_TESTNET_RPC_FALLBACKS) {
    try {
      return await fn(url);
    } catch (e) {
      console.log(`  ${url} failed, trying the next one…`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error("every Arc RPC failed");
}

const before = await withRpc((url) =>
  createPublicClient({ chain: arcTestnet, transport: http(url) }).readContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2_ADDRESS],
  }),
);
console.log(`sender ${account.address}`);
console.log(`allowance Permit2 before: ${formatUnits(before, 6)} USDC`);
if (before === 0n) {
  console.log("Already 0 — no revoke needed.");
  process.exit(0);
}

const hash = await withRpc((url) =>
  createWalletClient({ account, chain: arcTestnet, transport: http(url) }).writeContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, 0n],
  }),
);
console.log(`revoke tx: ${hash} — waiting for confirmation…`);
const receipt = await withRpc((url) =>
  createPublicClient({ chain: arcTestnet, transport: http(url) }).waitForTransactionReceipt({ hash }),
);
const after = await withRpc((url) =>
  createPublicClient({ chain: arcTestnet, transport: http(url) }).readContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2_ADDRESS],
  }),
);
console.log(`status: ${receipt.status}  |  Permit2 allowance after: ${formatUnits(after, 6)} USDC`);
