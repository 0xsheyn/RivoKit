/**
 * One-time demo funding: give the buyer USDC on Sepolia (bridge rail) and in
 * Circle Gateway (unified-balance rail), sourced from its Arc balance.
 *
 *   node scripts/demo-topup.mjs [--reset]
 *
 * Gateway deposits wait on Ethereum finality (~13 min) before they are spendable
 * — the marketplace reads the live balance and lights up the rail once confirmed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sleep } from "../src/lib/rpc.ts";
import { createBridge } from "../src/funding/bridge.ts";
import { createUnifiedBalance } from "../src/funding/unified-balance.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";

installCircleDnsPinning();
const STATE = ".demo-topup.json";
const BRIDGE_TO_SEPOLIA = parseUnits("10", 6);
const DEPOSIT_TO_GATEWAY = parseUnits("6", 6);

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}
const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
if (process.argv.includes("--reset") && existsSync(STATE)) writeFileSync(STATE, "{}");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const kit = new AppKit();
const bridge = createBridge(kit);
const ub = createUnifiedBalance(kit);
const arc = createViemAdapterFromPrivateKey({ privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Arc_Testnet });
const sep = createViemAdapterFromPrivateKey({ privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Ethereum_Sepolia });

if (!state.bridged) {
  console.log(`Bridge ${formatUnits(BRIDGE_TO_SEPOLIA, 6)} USDC Arc → Sepolia…`);
  const res = await bridge.execute({
    fromAdapter: arc, fromChain: BridgeChain.Arc_Testnet,
    toAdapter: sep, toChain: BridgeChain.Ethereum_Sepolia,
    amountMinor: BRIDGE_TO_SEPOLIA, kitKey: env.KIT_KEY,
  });
  state.bridged = res.state === "success";
  save();
  console.log(`  bridge ${res.state} — mint ${res.mintTxHash}`);
  await sleep(5000);
}

if (!state.deposited) {
  console.log(`Deposit ${formatUnits(DEPOSIT_TO_GATEWAY, 6)} USDC Sepolia → Gateway…`);
  const dep = await ub.deposit({ adapter: sep, chain: "Ethereum_Sepolia", amountMinor: DEPOSIT_TO_GATEWAY });
  state.deposited = true;
  save();
  console.log(`  deposit ter-mine — ${dep.txHash}`);
}

const gb = await ub.getBalance(sep);
console.log(`Gateway: confirmed ${formatUnits(gb.confirmedMinor, 6)} · pending ${formatUnits(gb.pendingMinor, 6)}`);
console.log("Done. The Sepolia balance (bridge rail) is ready; Gateway confirms ~13 minutes after the deposit.");
