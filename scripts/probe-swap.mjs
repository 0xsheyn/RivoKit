// Hypothesis from circlefin/arc-stablecoin-fx: route lookup may depend on the
// FROM wallet being a Circle Developer-Controlled wallet, not any EOA.
//
// The sample uses createCircleWalletsAdapter (not viem), constructs AppKit with
// NO arguments, and passes an explicit `address` in `from`. Reproduce that
// exactly, then compare against the viem path that failed.
import { readFileSync } from "node:fs";
import { AppKit, SwapChain } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

const short = (e) => `${e?.code ?? "?"} ${String(e?.message ?? e).slice(0, 120)}`;
const kit = new AppKit(); // no constructor args, exactly as the sample does
const chain = SwapChain.Arc_Testnet;

const circleAdapter = createCircleWalletsAdapter({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});
const viemAdapter = createViemAdapterFromPrivateKey({
  privateKey: env.BUYER_PRIVATE_KEY,
  chain,
});

const setups = [
  ["Circle wallet (deployer)", circleAdapter, env.DEPLOYER_ADDRESS],
  ["Circle wallet (merchant)", circleAdapter, env.MERCHANT_ADDRESS],
  ["EOA viem (buyer)", viemAdapter, "0x08C695b2eaccfb2Da60687eA7B92D9E5e220Bb71"],
];

console.log("Rute swap per tipe wallet asal — amountIn dalam satuan UTUH\n");

for (const [label, adapter, address] of setups) {
  console.log(`  ${label}  ${address}`);
  for (const [tokenIn, tokenOut] of [
    ["USDC", "EURC"],
    ["EURC", "USDC"],
  ]) {
    try {
      const est = await kit.estimateSwap({
        from: { adapter, chain, address },
        tokenIn,
        tokenOut,
        amountIn: "20",
        config: { kitKey: env.KIT_KEY },
      });
      console.log(
        `      OK    ${tokenIn}→${tokenOut}  out=${est.estimatedOutput.amount} ${est.estimatedOutput.token}` +
          `  stopLimit=${est.stopLimit?.amount ?? "-"}`,
      );
    } catch (e) {
      console.log(`     GAGAL  ${tokenIn}→${tokenOut}  ${short(e)}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log();
}
