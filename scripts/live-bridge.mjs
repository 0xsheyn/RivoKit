/**
 * Cross-chain USDC, live: Arc Testnet → Ethereum Sepolia.
 *
 * This is the refund direction (invariant 5: refunds go back to the order's
 * recorded receivingChain), and it doubles as funding for the opposite test —
 * the buyer holds USDC on Arc but none on Sepolia, so bridging out first is
 * what makes the inbound test possible without a faucet.
 *
 * CCTP is burn → attest → mint, and attestation is off-chain. Expect minutes.
 * The script records progress so an interruption can be continued rather than
 * restarted: re-burning would move a second amount, not recover the first.
 *
 *   node scripts/live-bridge.mjs [--reset]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, erc20Abi, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { USDC_ADDRESS } from "../src/constants/arc.ts";
import { createBridge, BridgeStuckError } from "../src/funding/bridge.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";

// This network hijacks Circle's DNS (see dns-api-circle-dibajak); pin the real
// IPs before any SDK call. Must run before AppKit is used.
installCircleDnsPinning();

const STATE_FILE = ".live-bridge.json";
const AMOUNT = parseUnits("3", 6);
const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
const arcClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const sepoliaClient = createPublicClient({ chain: sepolia, transport: http() });

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const fmt = (v) => formatUnits(v, 6);

const checks = [];
const record = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "  OK  " : " GAGAL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

if (process.argv.includes("--reset") && existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const arcUsdc = async () => {
  await sleep(250);
  return arcClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] });
};
const sepoliaUsdc = () =>
  sepoliaClient.readContract({ address: SEPOLIA_USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] });

const kit = new AppKit();

// A CCTP transfer takes minutes and reports progress only through events.
// Without this the run looks frozen, and a stall is indistinguishable from
// slowness — which matters because the two need different responses.
kit.on("*", (evt) => {
  const v = evt?.values;
  if (v?.name) info(`  [${v.name}] ${v.state}${v.txHash ? ` ${v.txHash}` : ""}`);
});

const bridge = createBridge(kit);

const arcAdapter = createViemAdapterFromPrivateKey({
  privateKey: env.BUYER_PRIVATE_KEY,
  chain: BridgeChain.Arc_Testnet,
});
const sepoliaAdapter = createViemAdapterFromPrivateKey({
  privateKey: env.BUYER_PRIVATE_KEY,
  chain: BridgeChain.Ethereum_Sepolia,
});

const params = {
  fromAdapter: arcAdapter,
  fromChain: BridgeChain.Arc_Testnet,
  toAdapter: sepoliaAdapter,
  toChain: BridgeChain.Ethereum_Sepolia,
  amountMinor: AMOUNT,
  kitKey: env.KIT_KEY,
};

// ── Saldo awal ─────────────────────────────────────────────────────────

step("Langkah 1 — saldo awal di kedua chain");

const beforeArc = await arcUsdc();
const beforeSepolia = await sepoliaUsdc();
const sepoliaEth = await sepoliaClient.getBalance({ address: buyer.address });

info(`Arc     ${fmt(beforeArc)} USDC`);
info(`Sepolia ${fmt(beforeSepolia)} USDC · ${formatUnits(sepoliaEth, 18)} ETH`);

record(beforeArc >= AMOUNT, "Arc punya cukup untuk di-bridge", fmt(beforeArc));
record(sepoliaEth > 0n, "Sepolia punya ETH untuk gas mint", formatUnits(sepoliaEth, 18));

// ── Estimasi ───────────────────────────────────────────────────────────

step("Langkah 2 — estimasi bridge Arc → Sepolia");

const est = await bridge.estimate(params);
info(`${est.amount} ${est.token}: ${est.sourceChain} → ${est.destinationChain}`);
for (const f of est.gasFees) info(`  gas ${f.name}: ${f.token} di ${f.blockchain}`);
record(est.sourceChain === "Arc_Testnet" && est.destinationChain === "Ethereum_Sepolia", "arah estimasi benar");

// ── Eksekusi ───────────────────────────────────────────────────────────

step("Langkah 3 — eksekusi bridge (CCTP: burn → atestasi → mint)");
info("ini butuh beberapa menit; atestasi CCTP off-chain");

if (!state.bridgeDone) {
  state.startedAt = new Date().toISOString();
  save();
  const t0 = Date.now();
  try {
    const res = await bridge.execute(params);
    state.bridgeDone = res.state === "success";
    state.result = { state: res.state, burn: res.burnTxHash, mint: res.mintTxHash };
    save();
    ok(`bridge selesai dalam ${Math.round((Date.now() - t0) / 1000)} detik — state ${res.state}`);
    info(`burn (Arc)     ${res.burnTxHash ?? "-"}`);
    info(`mint (Sepolia) ${res.mintTxHash ?? "-"}`);
    record(res.state === "success", "state bridge sukses", res.state);
    record(Boolean(res.burnTxHash), "burn tercatat di chain asal");
    record(Boolean(res.mintTxHash), "mint tercatat di chain tujuan");
  } catch (e) {
    if (e instanceof BridgeStuckError) {
      console.log(`\n  TERTAHAN — ${e.message}`);
      console.log("  Jalankan ulang skrip ini untuk melanjutkan; JANGAN reset.");
      process.exit(1);
    }
    throw e;
  }
} else {
  ok("bridge sudah tuntas di run sebelumnya");
}

// ── Verifikasi ─────────────────────────────────────────────────────────

step("Langkah 4 — verifikasi kedua chain");

await sleep(5000);
const afterArc = await arcUsdc();
const afterSepolia = await sepoliaUsdc();

info(`Arc     ${fmt(beforeArc)} → ${fmt(afterArc)}  (${fmt(afterArc - beforeArc)})`);
info(`Sepolia ${fmt(beforeSepolia)} → ${fmt(afterSepolia)}  (+${fmt(afterSepolia - beforeSepolia)})`);

const sepoliaGain = afterSepolia - beforeSepolia;
const arcSpent = beforeArc - afterArc;

record(arcSpent >= AMOUNT, "USDC keluar dari Arc", fmt(arcSpent));
record(sepoliaGain > 0n, "USDC tiba di Sepolia", fmt(sepoliaGain));
record(sepoliaGain <= AMOUNT, "yang tiba tidak melebihi yang dikirim", `${fmt(sepoliaGain)} <= ${fmt(AMOUNT)}`);

step("Hasil");
const failed = checks.filter((c) => !c).length;
console.log(
  `${checks.length - failed}/${checks.length} lolos.` +
    (failed ? " Ada yang gagal." : " Bridge lintas-chain TERBUKTI: Arc → Ethereum Sepolia."),
);
process.exit(failed ? 1 : 0);
