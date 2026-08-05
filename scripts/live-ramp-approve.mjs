/**
 * Grant the buyer's USDC allowance to Permit2 on Arc — the one prerequisite for
 * the live CPN broadcast test that preflight found missing.
 *
 * This is REVERSIBLE (allowance can be set back to 0) and is NOT the irreversible
 * payment. It approves a BOUNDED amount (not unlimited) so Permit2 can never pull
 * more than this cumulatively without a fresh approve. Each CPN transfer is still
 * separately bounded by the signed permit.
 *
 * Which wallet needs it depends on who sends: the scripted broadcast test signs
 * as BUYER, while the demo's own cash-out signs as the SELLER. Pick with SIGNER;
 * the allowance is per-wallet, so approving one proves nothing about the other.
 *
 *   node scripts/live-ramp-approve.mjs                 # BUYER (default)
 *   SIGNER=SELLER node scripts/live-ramp-approve.mjs   # the demo's seller
 */
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_RPC_URL, PERMIT2_ADDRESS, USDC_ADDRESS, arcTestnet } from "../src/constants/arc.ts";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();

const SIGNER = (process.env.SIGNER ?? "BUYER").toUpperCase();
const pk = env[`${SIGNER}_PRIVATE_KEY`];
if (!pk) {
  console.error(`FAILED: ${SIGNER}_PRIVATE_KEY missing from .env.local`);
  process.exit(1);
}
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC_URL) });
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC_URL) });

const APPROVE = 40n * 10n ** 6n; // 40 USDC — enough for a couple of min-size tests.

const before = await pub.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] });
console.log(`sender ${account.address}`);
console.log(`allowance Permit2 before: ${formatUnits(before, 6)} USDC`);

if (before >= APPROVE) {
  console.log("Already sufficient — no approve needed.");
  process.exit(0);
}

const hash = await wallet.writeContract({
  address: USDC_ADDRESS,
  abi: erc20Abi,
  functionName: "approve",
  args: [PERMIT2_ADDRESS, APPROVE],
});
console.log(`approve tx: ${hash}  — waiting for confirmation…`);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`status: ${receipt.status}`);

const after = await pub.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] });
console.log(`Permit2 allowance after: ${formatUnits(after, 6)} USDC`);
