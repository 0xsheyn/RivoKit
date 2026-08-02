/**
 * Probe: is there enough on the source chain to exercise the browser wallet rails?
 *
 * Read-only. Reports the buyer's source-chain gas and USDC, its Gateway
 * unified balance, and its Arc USDC — the four numbers that decide which of the
 * two rails can actually be proven right now.
 *
 *   node scripts/probe-wallet-rails.mjs
 */
import { createPublicClient, erc20Abi, formatEther, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, avalancheFuji } from "viem/chains";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createUnifiedBalance } from "../src/funding/unified-balance.ts";
import { arcTransport } from "../src/lib/rpc.ts";
import { USDC_ADDRESS } from "../src/constants/arc.ts";
import { SOURCE_USDC } from "../demo/app/wallet-rails.ts";
import { SOURCE_CHAIN } from "../demo/lib/source-chain.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";

// Every *.circle.com is DNS-hijacked on this network, Gateway included. Without
// this the balance read fails as "fetch failed" after 10 retries, which reads
// like an outage rather than what it is.
installCircleDnsPinning();

const env = readEnv();
const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);

const sep = createPublicClient({ chain: avalancheFuji, transport: http() });
const arc = createPublicClient({ chain: arcTestnet, transport: arcTransport() });

const fmt = (v) => formatUnits(v, 6);

console.log(`buyer ${buyer.address}\n`);

const [srcGas, srcUsdc, arcUsdc] = await Promise.all([
  sep.getBalance({ address: buyer.address }),
  sep.readContract({ address: SOURCE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] }),
  arc.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] }),
]);

console.log(`source-chain gas  ${formatEther(srcGas)}`);
console.log(`source USDC ${fmt(srcUsdc)}`);
console.log(`Arc USDC     ${fmt(arcUsdc)}`);

const ub = createUnifiedBalance(new AppKit());
const adapter = createViemAdapterFromPrivateKey({ privateKey: env.BUYER_PRIVATE_KEY, chain: SOURCE_CHAIN.name });
try {
  const bal = await ub.getBalance(adapter);
  console.log(`Gateway      confirmed ${fmt(bal.confirmedMinor)} · pending ${fmt(bal.pendingMinor)}`);
} catch (e) {
  console.log(`Gateway      unreadable: ${String(e?.message ?? e).slice(0, 160)}`);
}

console.log("");
console.log(srcGas > 0n ? "gas OK on the source chain" : "NO source-chain gas — neither rail can send a transaction");
