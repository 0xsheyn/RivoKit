/**
 * Close the last gap in the chain: the seller's EURC on Arc → the Mint EUR
 * balance → a SEPA bank.
 *
 * The project long assumed this leg needed a CCTP bridge, because Arc is not a
 * Circle Mint chain for USDC. It turns out Circle exposes a deposit address for
 * **EUR on ARC**, which `mintDepositInfo()` was discarding by filtering to USD.
 * So the seller's floored EURC goes straight in — no bridge, no detour through
 * dollars, and the euro guarantee survives the whole way to the bank.
 *
 * That makes the full path:
 *   escrow → floored swap (≥ €P) → seller EURC on Arc
 *          → THIS transfer → Mint EUR balance → redeem → SEPA
 *
 * The transfer is an ordinary ERC-20 send signed by the seller key, so it is
 * irreversible and gated. Crediting is async: Circle confirms on its own clock,
 * so the script polls the EUR balance afterwards rather than assuming.
 *
 *   node scripts/live-mint-arc-deposit.mjs                  # inspect only
 *   CONFIRM=DEPOSIT node scripts/live-mint-arc-deposit.mjs  # send EUR_AMOUNT
 */
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { EURC_ADDRESS, arcTestnet } from "../src/constants/arc.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();

const env = readEnv();
const rampKey = env.CIRCLE_RAMP_KEY;
const sellerPk = env.RELAYER_PRIVATE_KEY;
if (!rampKey || !sellerPk) {
  console.error("FAILED: CIRCLE_RAMP_KEY and RELAYER_PRIVATE_KEY are both required");
  process.exit(1);
}

const EUR_AMOUNT = process.env.EUR_AMOUNT ?? "1";
const BASE = "https://api-sandbox.circle.com";

const mint = async (method, path) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${rampKey}`, "Content-Type": "application/json" },
  });
  const j = await res.json().catch(() => null);
  return j?.data ?? j;
};

const eurOf = (bal) => bal?.available?.find((b) => b.currency === "EUR")?.amount ?? "0.00";

// ── Where does EUR on Arc go? Ask Circle, never hardcode. ──────────────
const addrs = await mint("GET", "/v1/businessAccount/wallets/addresses/deposit");
const route = (addrs ?? []).find((a) => a.currency === "EUR" && a.chain === "ARC");
if (!route) {
  console.error("FAILED: Circle lists no EUR deposit address on ARC for this account.");
  console.error("Routes offered:", JSON.stringify(addrs));
  process.exit(1);
}
console.log(`Mint EUR deposit address on Arc: ${route.address}`);

const seller = privateKeyToAccount(sellerPk);
const client = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const eurc = { address: EURC_ADDRESS, abi: erc20Abi };

const onChain = await client.readContract({ ...eurc, functionName: "balanceOf", args: [seller.address] });
const balBefore = await mint("GET", "/v1/businessAccount/balances");
console.log(`Seller ${seller.address}`);
console.log(`  EURC on Arc:      ${formatUnits(onChain, 6)}`);
console.log(`  Mint EUR balance: ${eurOf(balBefore)}`);

const amount = parseUnits(EUR_AMOUNT, 6);
if (onChain < amount) {
  console.error(`\nFAILED: seller holds ${formatUnits(onChain, 6)} EURC, needs ${EUR_AMOUNT}.`);
  process.exit(1);
}

if (process.env.CONFIRM !== "DEPOSIT") {
  console.log(`\nStopping here — inspection only. An on-chain transfer cannot be undone.`);
  console.log(`To send ${EUR_AMOUNT} EURC into the Mint balance:`);
  console.log(`  CONFIRM=DEPOSIT node scripts/live-mint-arc-deposit.mjs`);
  process.exit(0);
}

// ── Send ───────────────────────────────────────────────────────────────
const wallet = createWalletClient({ account: seller, chain: arcTestnet, transport: arcTransport() });
const hash = await wallet.writeContract({
  ...eurc,
  functionName: "transfer",
  args: [route.address, amount],
});
console.log(`\ntransfer ${EUR_AMOUNT} EURC → ${route.address}`);
console.log(`  tx ${hash}`);
const receipt = await client.waitForTransactionReceipt({ hash });
console.log(`  ${receipt.status} in block ${receipt.blockNumber}`);
if (receipt.status !== "success") process.exit(1);

// ── Crediting is async — poll rather than assume. ──────────────────────
const target = eurOf(balBefore);
for (let i = 0; i < 30; i++) {
  await sleep(20000);
  const now = eurOf(await mint("GET", "/v1/businessAccount/balances"));
  console.log(`  Mint EUR: ${now}${now !== target ? "  ← credited" : ""}`);
  if (now !== target) break;
}
console.log("\nIf the balance has not moved yet it is still confirming; re-check with probe-mint-sepa.mjs.");
