/**
 * Is the buyer funded on the chains they can actually pay FROM?
 *
 * `preflight.mjs` reads Arc and only Arc, which is right for what it checks —
 * escrow, swap and payout all live there. But the demo's opening move is
 * cross-chain funding: the buyer holds USDC on Fuji, Base, Sepolia or Amoy and
 * bridges it in. Nothing verifies that, so a demo can pass 8/8 and still fail on
 * its first click in front of an audience.
 *
 * TWO balances per chain, not one, because they fail differently and both are
 * fatal:
 *
 *   USDC   — what actually moves.
 *   native — what pays for moving it. This is the trap Arc trains you out of:
 *            there USDC IS the gas token, so a funded wallet is a working
 *            wallet. On every chain here gas is ETH/AVAX/POL instead, and a
 *            wallet holding USDC with no native balance cannot even approve.
 *
 * Read-only: two `eth_call`s per chain, no keys used beyond deriving an address.
 *
 *   node scripts/check-source-chains.mjs
 */
import { createPublicClient, erc20Abi, fallback, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readEnv } from "./lib/env.mjs";
import { SOURCE_CHAINS } from "../demo/lib/source-chain.ts";

const env = readEnv();
if (!env.BUYER_PRIVATE_KEY) {
  console.error("BUYER_PRIVATE_KEY is empty — check .env.local");
  process.exitCode = 1;
} else {
  const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
  console.log(`Source-chain funding for the buyer\n  ${buyer.address}\n`);

  let blocked = 0;
  for (const c of SOURCE_CHAINS) {
    // Every endpoint, not just the first: a free public RPC answers 403 whenever
    // it decides it dislikes the caller, and a single-endpoint read turns that
    // into a false "unfunded".
    const client = createPublicClient({ transport: fallback(c.rpcUrls.map((u) => http(u))) });
    try {
      const [native, usdc] = await Promise.all([
        client.getBalance({ address: buyer.address }),
        client.readContract({
          address: c.usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [buyer.address],
        }),
      ]);
      const usable = usdc > 0n && native > 0n;
      // A disabled rail is reported but never counted against the run: Amoy's
      // CCTP burn reverts regardless of how well funded it is, and failing the
      // check for it would train you to ignore the check.
      if (!usable && !c.disabledReason) blocked += 1;
      console.log(
        `  ${usable ? "OK  " : "MISS"}  ${c.label.padEnd(18)}` +
          `${formatUnits(usdc, 6).padStart(12)} USDC  ` +
          `${Number(formatUnits(native, 18)).toFixed(5).padStart(10)} ${c.nativeCurrency.symbol}` +
          (c.disabledReason ? `   rail disabled — ${c.disabledReason}` : "") +
          (usable || c.disabledReason ? "" : usdc === 0n ? "   no USDC" : "   no gas"),
      );
    } catch (err) {
      // An unreachable endpoint is not the same finding as an empty wallet, and
      // conflating them would send you to a faucet to fix a network problem.
      console.log(`  ERR   ${c.label.padEnd(18)}${String(err?.shortMessage ?? err?.message ?? err).slice(0, 90)}`);
      if (!c.disabledReason) blocked += 1;
    }
  }

  console.log(
    blocked === 0
      ? "\nEvery enabled source chain can fund an order."
      : `\n${blocked} enabled source chain(s) cannot fund an order yet. ` +
          "A chain needs BOTH its USDC and its own native gas token.",
  );
  process.exitCode = blocked === 0 ? 0 : 1;
}
