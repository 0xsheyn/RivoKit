/**
 * Prove the Circle Mint DEPOSIT leg — on-chain USDC → Mint balance.
 *
 * Circle Mint credits USDC sent to its per-chain deposit address (testnets in
 * sandbox). Arc is NOT a Mint chain, so the seller's Arc USDC would need a CCTP
 * bridge first; here we demonstrate the deposit itself on Sepolia (chain "ETH")
 * using the buyer's Sepolia USDC. Crediting is async (real testnet confirmation
 * times), so we poll and report whether it landed in the window.
 *
 *   node scripts/probe-mint-deposit.mjs
 */
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();

const env = readEnv();
const BASE = "https://api-sandbox.circle.com";
const key = env.CIRCLE_RAMP_KEY;
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

async function mintCall(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${key}` } });
  return (await r.json())?.data;
}
const usdBalance = (bal) => Number((bal?.available ?? []).find((b) => b.currency === "USD")?.amount ?? "0");

// 1. Mint deposit address for the ETH (Sepolia) chain.
const addrs = await mintCall("/v1/businessAccount/wallets/addresses/deposit");
const dep = (addrs ?? []).find((a) => a.chain === "ETH");
if (!dep) { console.error("No ETH deposit address."); process.exit(1); }
console.log(`Mint deposit address (ETH/Sepolia): ${dep.address}`);

const before = usdBalance(await mintCall("/v1/businessAccount/balances"));
console.log(`Mint balance before: ${before} USD`);

// 2. Send 5 USDC from the buyer on Sepolia to the deposit address.
const account = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
const rpc = "https://ethereum-sepolia-rpc.publicnode.com";
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
const amount = parseUnits("5", 6);

console.log(`Mengirim 5 USDC (Sepolia) ${account.address} → ${dep.address} …`);
const hash = await wallet.writeContract({
  address: SEPOLIA_USDC, abi: erc20Abi, functionName: "transfer", args: [dep.address, amount],
});
console.log(`tx: ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`konfirmasi on-chain: ${receipt.status}`);

// 3. Poll the Mint balance for the credit (async — may take minutes).
console.log("Waiting for Circle to credit the deposit (polling ~3 min)…");
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const now = usdBalance(await mintCall("/v1/businessAccount/balances"));
  if (now > before) {
    console.log(`  ✅ ter-kredit: ${before} → ${now} USD (+${(now - before).toFixed(2)})`);
    process.exit(0);
  }
  console.log(`  poll ${i}: still ${now} USD`);
}
console.log("Not credited within this window — deposits are processed async, check the balance again later.");
