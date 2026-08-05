/**
 * One-time demo funding: give the buyer USDC on the source chain (bridge rail)
 * and in Circle Gateway (unified-balance rail), sourced from its Arc balance.
 *
 *   node scripts/demo-topup.mjs [--reset]
 *
 * The chain is whatever demo/lib/source-chain.ts names, so this stays in step
 * with the rails it funds. A Gateway deposit is spendable only after the source
 * chain finalises — seconds on a fast-finality chain, ~13 min from Ethereum —
 * and the marketplace lights the rail up once the live balance confirms.
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
import { readEnv } from "./lib/env.mjs";
import { stateFile } from "./lib/state.mjs";
import { SOURCE_CHAIN } from "../demo/lib/source-chain.ts";

installCircleDnsPinning();
const STATE = stateFile("demo-topup");
const BRIDGE_TO_SOURCE = parseUnits("10", 6);
const DEPOSIT_TO_GATEWAY = parseUnits("6", 6);

const env = readEnv();
const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
if (process.argv.includes("--reset") && existsSync(STATE)) writeFileSync(STATE, "{}");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const kit = new AppKit();
const bridge = createBridge(kit);
const ub = createUnifiedBalance(kit);
const arc = createViemAdapterFromPrivateKey({ privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Arc_Testnet });
const src = createViemAdapterFromPrivateKey({ privateKey: env.BUYER_PRIVATE_KEY, chain: SOURCE_CHAIN.name });

if (!state.bridged) {
  console.log(`Bridge ${formatUnits(BRIDGE_TO_SOURCE, 6)} USDC Arc → ${SOURCE_CHAIN.label}…`);
  const res = await bridge.execute({
    fromAdapter: arc, fromChain: BridgeChain.Arc_Testnet,
    toAdapter: src, toChain: SOURCE_CHAIN.name,
    amountMinor: BRIDGE_TO_SOURCE, kitKey: env.KIT_KEY,
  });
  state.bridged = res.state === "success";
  save();
  console.log(`  bridge ${res.state} — mint ${res.mintTxHash}`);
  await sleep(5000);
}

if (!state.deposited) {
  console.log(`Deposit ${formatUnits(DEPOSIT_TO_GATEWAY, 6)} USDC ${SOURCE_CHAIN.label} → Gateway…`);
  const dep = await ub.deposit({ adapter: src, chain: SOURCE_CHAIN.name, amountMinor: DEPOSIT_TO_GATEWAY });
  state.deposited = true;
  save();
  console.log(`  deposit ter-mine — ${dep.txHash}`);
}

const gb = await ub.getBalance(src);
console.log(`Gateway: confirmed ${formatUnits(gb.confirmedMinor, 6)} · pending ${formatUnits(gb.pendingMinor, 6)}`);
console.log(`Done. The ${SOURCE_CHAIN.label} balance (bridge rail) is ready; Gateway confirms once that chain finalises.`);
