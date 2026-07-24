/**
 * Revoke the buyer's Permit2 USDC allowance (set it back to 0) on Arc.
 *
 * Housekeeping after the broadcast test — leaves no standing approval. Rotates
 * through the Arc RPC fallbacks because the public endpoint rate-limits.
 *
 *   node scripts/live-ramp-revoke.mjs
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_RPC_FALLBACKS, PERMIT2_ADDRESS, USDC_ADDRESS, arcTestnet } from "../src/constants/arc.ts";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}
const account = privateKeyToAccount(env.BUYER_PRIVATE_KEY);

async function withRpc(fn) {
  for (const url of ARC_TESTNET_RPC_FALLBACKS) {
    try {
      return await fn(url);
    } catch (e) {
      console.log(`  ${url} gagal, coba berikutnya…`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error("semua RPC Arc gagal");
}

const before = await withRpc((url) =>
  createPublicClient({ chain: arcTestnet, transport: http(url) }).readContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2_ADDRESS],
  }),
);
console.log(`sender ${account.address}`);
console.log(`allowance Permit2 sebelum: ${formatUnits(before, 6)} USDC`);
if (before === 0n) {
  console.log("Sudah 0 — tidak perlu revoke.");
  process.exit(0);
}

const hash = await withRpc((url) =>
  createWalletClient({ account, chain: arcTestnet, transport: http(url) }).writeContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, 0n],
  }),
);
console.log(`revoke tx: ${hash} — menunggu konfirmasi…`);
const receipt = await withRpc((url) =>
  createPublicClient({ chain: arcTestnet, transport: http(url) }).waitForTransactionReceipt({ hash }),
);
const after = await withRpc((url) =>
  createPublicClient({ chain: arcTestnet, transport: http(url) }).readContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2_ADDRESS],
  }),
);
console.log(`status: ${receipt.status}  |  allowance Permit2 sesudah: ${formatUnits(after, 6)} USDC`);
