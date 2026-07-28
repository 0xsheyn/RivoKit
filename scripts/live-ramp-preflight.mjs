/**
 * Preflight for the live CPN broadcast test — READ ONLY, moves nothing.
 *
 * The broadcast (ramp.submit) needs a sender wallet on Arc that (1) holds enough
 * USDC and (2) has approved Permit2 to spend it. This checks both for every EOA
 * whose key we hold, so we can pick a funded sender and see whether an approve
 * is still needed. Native (gas) balance is shown too — on Arc gas is USDC.
 *
 *   node scripts/live-ramp-preflight.mjs
 */
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_RPC_URL, PERMIT2_ADDRESS, USDC_ADDRESS, arcTestnet } from "../src/constants/arc.ts";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();

const client = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC_URL) });
const fmt = (v) => formatUnits(v, 6);

const candidates = [
  ["BUYER", env.BUYER_PRIVATE_KEY],
  ["DEPLOYER", env.DEPLOYER_PRIVATE_KEY],
  ["RELAYER", env.RELAYER_PRIVATE_KEY],
].filter(([, k]) => k);

// The CPN quote minimum is 11 USDC; leave headroom for the fee.
const MIN_USDC = 12n * 10n ** 6n;

console.log("Preflight uji broadcast CPN — Arc Testnet\n");
for (const [name, pk] of candidates) {
  const account = privateKeyToAccount(pk);
  try {
    const [usdc, allowance, native] = await Promise.all([
      client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2_ADDRESS] }),
      client.getBalance({ address: account.address }),
    ]);
    const fundedOk = usdc >= MIN_USDC;
    const allowOk = allowance >= MIN_USDC;
    console.log(`${name}  ${account.address}`);
    console.log(`  USDC (ERC-20): ${fmt(usdc)}   ${fundedOk ? "OK" : `< ${fmt(MIN_USDC)} — perlu faucet`}`);
    console.log(`  Permit2 allowance: ${allowance === 0n ? "0" : fmt(allowance)}   ${allowOk ? "OK" : "perlu approve"}`);
    console.log(`  Native gas (USDC 18dp): ${formatUnits(native, 18)}`);
    console.log(`  → ${fundedOk && allowOk ? "READY as sender" : "not ready"}\n`);
  } catch (e) {
    console.log(`${name}  ${account.address}\n  ERROR baca chain: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 120)}\n`);
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log("Faucet USDC Arc: https://faucet.circle.com   |   Permit2:", PERMIT2_ADDRESS);
