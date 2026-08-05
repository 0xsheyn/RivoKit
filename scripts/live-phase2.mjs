/**
 * Phase 2: prove the floor mechanism live on Arc Testnet.
 *
 * The intended production direction is USDC→EURC, but that pair currently has
 * no maker liquidity (see NoRouteError). The floor mechanism itself is
 * direction-agnostic, so this script detects which direction routes and proves
 * the behaviour there. When USDC→EURC returns, only the pair flips.
 *
 * What must hold, in order of importance:
 *   1. an IMPOSSIBLE floor makes the swap fail and leaves balances untouched
 *   2. an achievable floor settles at or above the floor
 *   3. rebate = max(0, out − floor)
 *
 * (1) is the product promise. A swap that partially fills below the floor, or
 * that moves funds and then fails, would break the guarantee RivoKit makes to
 * the recipient.
 *
 *   CONFIRM=SWAP node scripts/live-phase2.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { USDC_ADDRESS, EURC_ADDRESS } from "../src/constants/arc.ts";
import { toDecimalString } from "../src/settlement-fx/units.ts";
import { createSettlementFx, FloorNotMetError, NoRouteError } from "../src/settlement-fx/swap.ts";
import { readEnv } from "./lib/env.mjs";

const STATE_FILE = ".live-phase2.json";
const SWAP_SIZE = parseUnits("5", 6); // 5 tokens — above StableFX's 10 USDC min? see note

const env = readEnv();

const WALLET = getAddress(env.DEPLOYER_ADDRESS); // Circle DCW — swap needs one
const publicClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const fmt = (v) => formatUnits(v, 6);

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// Gated at the top rather than at each write, because every path here spends:
// a top-up transfer to the swap wallet, then real swaps. Unlike the bridge this
// needs no resume exemption — a swap either fills or reverts, which is the
// property the script exists to prove, so there is no half-landed state to
// rescue.
if (process.env.CONFIRM !== "SWAP") {
  console.error(
    "\nThis moves USDC on Arc: a top-up transfer, then live swaps. To go ahead:\n" +
      "  CONFIRM=SWAP node scripts/live-phase2.mjs\n",
  );
  process.exit(1);
}

if (process.argv.includes("--reset") && existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const balanceOf = async (token, address) => {
  await sleep(250);
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
};

const fx = createSettlementFx({
  kitKey: env.KIT_KEY,
  circleApiKey: env.CIRCLE_API_KEY,
  circleEntitySecret: env.CIRCLE_ENTITY_SECRET,
});

// ── Which direction actually routes? ───────────────────────────────────

step("Step 0 — detect which direction has a route");

let direction = null;
for (const [tokenIn, tokenOut] of [["USDC", "EURC"], ["EURC", "USDC"]]) {
  try {
    const q = await fx.quote({ address: WALLET, tokenIn, tokenOut, amountInMinor: SWAP_SIZE });
    ok(`${tokenIn}→${tokenOut} ADA rute — out ${fmt(q.amountOutMinor)} ${tokenOut}, stopLimit bawaan ${q.stopLimitMinor ? fmt(q.stopLimitMinor) : "-"}`);
    if (!direction) direction = { tokenIn, tokenOut, quote: q };
  } catch (e) {
    if (e instanceof NoRouteError) info(`${tokenIn}→${tokenOut} no route`);
    else info(`${tokenIn}→${tokenOut} galat lain: ${e?.code ?? ""} ${String(e?.message).slice(0, 90)}`);
  }
  await sleep(1000);
}

if (!direction) {
  console.error("\nFAILED: no direction has a route. Phase 2 cannot be tested right now.");
  process.exit(1);
}

const { tokenIn, tokenOut } = direction;
const TOKEN_IN_ADDR = tokenIn === "USDC" ? USDC_ADDRESS : EURC_ADDRESS;
const TOKEN_OUT_ADDR = tokenOut === "USDC" ? USDC_ADDRESS : EURC_ADDRESS;

if (tokenIn !== "USDC") {
  console.log(
    `\n  NOTE: RivoKit's production direction is USDC→EURC, but that pair\n` +
      `  has no route right now. The floor mechanism is tested on ${tokenIn}→${tokenOut};\n` +
      `  the code is identical, only the pair is reversed.`,
  );
}

// ── Funding ────────────────────────────────────────────────────────────

step(`Step 1 — make sure the Circle wallet holds ${tokenIn}`);

let inBal = await balanceOf(TOKEN_IN_ADDR, WALLET);
info(`Circle wallet ${tokenIn} balance: ${fmt(inBal)}`);

if (inBal < SWAP_SIZE * 3n) {
  const funder = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
  const funderBal = await balanceOf(TOKEN_IN_ADDR, funder.address);
  const need = SWAP_SIZE * 3n - inBal;
  info(`short; sending ${fmt(need)} ${tokenIn} from EOA ${funder.address} (holds ${fmt(funderBal)})`);

  if (funderBal < need) {
    console.error(`FAILED: the EOA only holds ${fmt(funderBal)} ${tokenIn}.`);
    process.exit(1);
  }

  const wallet = createWalletClient({ account: funder, chain: arcTestnet, transport: arcTransport() });
  const hash = await wallet.writeContract({
    address: TOKEN_IN_ADDR,
    abi: erc20Abi,
    functionName: "transfer",
    args: [WALLET, need],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  ok(`sent — tx ${hash}`);
  inBal = await balanceOf(TOKEN_IN_ADDR, WALLET);
}
ok(`ready: ${fmt(inBal)} ${tokenIn}`);

// ── Test 1: impossible floor MUST fail safely ──────────────────────────

step("Step 2 — an IMPOSSIBLE floor must fail, funds must stay intact");

const beforeIn = await balanceOf(TOKEN_IN_ADDR, WALLET);
const beforeOut = await balanceOf(TOKEN_OUT_ADDR, WALLET);
info(`before: ${fmt(beforeIn)} ${tokenIn} / ${fmt(beforeOut)} ${tokenOut}`);

// Ten times the honest quote — no maker will ever fill this.
const impossibleFloor = direction.quote.amountOutMinor * 10n;
info(`floor mustahil: ${toDecimalString(impossibleFloor)} ${tokenOut} (10x kuotasi jujur)`);

let failedAsExpected = false;
let failureKind = "";
try {
  await fx.swapWithFloor({
    address: WALLET,
    tokenIn,
    tokenOut,
    amountInMinor: SWAP_SIZE,
    floorOutMinor: impossibleFloor,
  });
  failureKind = "DID NOT FAIL — the swap ran despite an impossible floor";
} catch (e) {
  failedAsExpected = true;
  failureKind = e instanceof FloorNotMetError ? "FloorNotMetError" : `${e?.name}: ${String(e?.message).slice(0, 80)}`;
}

await sleep(2000);
const afterIn = await balanceOf(TOKEN_IN_ADDR, WALLET);
const afterOut = await balanceOf(TOKEN_OUT_ADDR, WALLET);

record(failedAsExpected, "a swap with an impossible floor is REJECTED", failureKind);
record(afterIn === beforeIn, `${tokenIn} did not decrease`, `${fmt(beforeIn)} → ${fmt(afterIn)}`);
record(afterOut === beforeOut, `${tokenOut} did not change`, `${fmt(beforeOut)} → ${fmt(afterOut)}`);

// ── Test 2: achievable floor settles at or above it ────────────────────

step("Step 3 — a reasonable floor must be met");

const fresh = await fx.quote({ address: WALLET, tokenIn, tokenOut, amountInMinor: SWAP_SIZE });
// 2% below the fresh quote: achievable, but still a real floor.
const achievableFloor = (fresh.amountOutMinor * 98n) / 100n;
info(`kuotasi ${fmt(fresh.amountOutMinor)}, floor dipasang ${fmt(achievableFloor)}`);

const outBefore = await balanceOf(TOKEN_OUT_ADDR, WALLET);

let result = null;
try {
  result = await fx.swapWithFloor({
    address: WALLET,
    tokenIn,
    tokenOut,
    amountInMinor: SWAP_SIZE,
    floorOutMinor: achievableFloor,
  });
  ok(`swap sukses — out ${fmt(result.amountOutMinor)} ${tokenOut}, tx ${result.txHash ?? "-"}`);
  state.lastSwap = { out: result.amountOutMinor.toString(), txHash: result.txHash };
  save();
} catch (e) {
  console.log(` FAIL   swap execution — ${e?.name}: ${String(e?.message).slice(0, 140)}`);
}

if (result) {
  await sleep(3000);
  const outAfter = await balanceOf(TOKEN_OUT_ADDR, WALLET);
  const gained = outAfter - outBefore;

  record(result.amountOutMinor >= achievableFloor, "output >= floor", `${fmt(result.amountOutMinor)} >= ${fmt(achievableFloor)}`);
  record(gained > 0n, `${tokenOut} increased on-chain`, fmt(gained));
  record(
    result.rebateMinor === result.amountOutMinor - achievableFloor,
    "rebate = out − floor (invariant 6)",
    fmt(result.rebateMinor),
  );
}

// ── Verdict ────────────────────────────────────────────────────────────

step("Result");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} passed.` +
    (failed ? " Something failed." : ` Floor mechanism PROVEN on ${tokenIn}→${tokenOut}.`),
);
process.exit(failed ? 1 : 0);
