/**
 * npm run setup — bootstrap RivoKit on Arc Testnet (DEPLOYMENT.md §2).
 *
 * Idempotent by design. Every stage checks .env.local first and skips work that
 * is already done, so an interrupted run (Arc's RPC and Circle's API both cut
 * out mid-flight) can simply be re-run.
 *
 * Stages:
 *   1. Ensure a Circle Developer-Controlled wallet set + deployer/operator/
 *      merchant wallets. Three SEPARATE wallets — DEPLOYMENT.md §2 requires the
 *      operator (hot, signs every payment) not to hold deploy authority.
 *   2. Deploy RivoKit's own instances of the Commerce Payments Protocol
 *      contracts via Circle SCP, from the pinned artifacts in contracts/.
 *   3. Write every resulting id/address back into .env.local.
 *
 *   node scripts/setup.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createCircleClient } from "./lib/circle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = resolve(ROOT, ".env.local");

// ── env helpers ────────────────────────────────────────────────────────

function readEnv() {
  const env = {};
  if (!existsSync(ENV)) return env;
  for (const line of readFileSync(ENV, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) env[m[1]] = m[2];
  }
  return env;
}

/** Merge keys into .env.local, preserving comments and ordering. */
function writeEnv(updates) {
  const lines = existsSync(ENV) ? readFileSync(ENV, "utf8").split(/\r?\n/) : [];
  const remaining = { ...updates };

  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && m[1] in remaining) {
      const key = m[1];
      const value = remaining[key];
      delete remaining[key];
      return `${key}=${value}`;
    }
    return line;
  });

  const extra = Object.entries(remaining).map(([k, v]) => `${k}=${v}`);
  if (extra.length) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(...extra);
  }
  writeFileSync(ENV, out.join("\n").replace(/\n{3,}$/, "\n\n"), "utf8");
}

const step = (msg) => console.log(`\n▸ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);

// ── main ───────────────────────────────────────────────────────────────

const env = readEnv();
if (!env.CIRCLE_API_KEY || !env.CIRCLE_ENTITY_SECRET) {
  console.error("GAGAL: .env.local belum lengkap. Jalankan: node scripts/sync-env.mjs");
  process.exit(1);
}

const circle = createCircleClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

const BLOCKCHAIN = env.CIRCLE_BLOCKCHAIN || "ARC-TESTNET";
const WALLET_SET_NAME = "RivoKit";
const ROLES = ["DEPLOYER", "OPERATOR", "MERCHANT"];

// ── Stage 1: wallets ───────────────────────────────────────────────────

step("Tahap 1 — wallet Developer-Controlled");

let walletSetId = env.CIRCLE_WALLET_SET_ID;

if (walletSetId) {
  ok(`wallet set sudah ada: ${walletSetId}`);
} else {
  const sets = await circle.listWalletSets();
  const existing = (sets?.walletSets ?? []).find((s) => s.name === WALLET_SET_NAME);
  if (existing) {
    walletSetId = existing.id;
    ok(`wallet set ditemukan: ${walletSetId}`);
  } else {
    const created = await circle.createWalletSet(WALLET_SET_NAME);
    walletSetId = created.walletSet.id;
    ok(`wallet set dibuat: ${walletSetId}`);
  }
  writeEnv({ CIRCLE_WALLET_SET_ID: walletSetId });
}

const missing = ROLES.filter((r) => !env[`${r}_WALLET_ID`]);

if (missing.length === 0) {
  ok("ketiga wallet sudah tercatat di .env.local");
  for (const r of ROLES) info(`${r.padEnd(8)} ${env[`${r}_ADDRESS`]}`);
} else {
  info(`membuat ${missing.length} wallet: ${missing.join(", ")}`);
  const created = await circle.createWallets({
    walletSetId,
    blockchains: [BLOCKCHAIN],
    count: missing.length,
    accountType: "EOA",
  });

  const wallets = created.wallets ?? [];
  if (wallets.length !== missing.length) {
    console.error(
      `GAGAL: minta ${missing.length} wallet, dapat ${wallets.length}. Tidak menulis apa pun.`,
    );
    process.exit(1);
  }

  const updates = {};
  missing.forEach((role, i) => {
    updates[`${role}_WALLET_ID`] = wallets[i].id;
    updates[`${role}_ADDRESS`] = wallets[i].address;
    ok(`${role.padEnd(8)} ${wallets[i].address}  (${wallets[i].id})`);
  });
  writeEnv(updates);
}

// ── Stage 2: fund the Circle wallets with gas ──────────────────────────
//
// Arc bills gas in USDC, so a wallet with no USDC cannot transact at all.
// Funds come from the pre-existing EOA that already holds faucet USDC.

step("Tahap 2 — isi gas (USDC) untuk wallet Circle");

const { createPublicClient, createWalletClient, erc20Abi, formatUnits, parseUnits } =
  await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const { arcTestnet } = await import("viem/chains");
const { arcTransport, sleep } = await import("../src/lib/rpc.ts");
const { USDC_ADDRESS } = await import("../src/constants/arc.ts");

const transport = arcTransport({
  preferred: env.NEXT_PUBLIC_ARC_RPC_URL ? [env.NEXT_PUBLIC_ARC_RPC_URL] : [],
});
const pub = createPublicClient({ chain: arcTestnet, transport });

/** Target gas float per role. Merchant only receives, so it needs none. */
const GAS_TARGET = { DEPLOYER: "25", OPERATOR: "15" };

const readEnvNow = readEnv();
const funder = privateKeyToAccount(readEnvNow.DEPLOYER_PRIVATE_KEY);
const wallet = createWalletClient({ account: funder, chain: arcTestnet, transport });

const usdcBalance = (address) =>
  pub.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });

info(`sumber dana: ${funder.address} — ${formatUnits(await usdcBalance(funder.address), 6)} USDC`);

for (const [role, target] of Object.entries(GAS_TARGET)) {
  const to = readEnvNow[`${role}_ADDRESS`];
  if (!to) {
    info(`${role}: alamat belum ada, dilewati`);
    continue;
  }
  await sleep(300);
  const current = await usdcBalance(to);
  const want = parseUnits(target, 6);

  if (current >= want) {
    ok(`${role} sudah cukup: ${formatUnits(current, 6)} USDC`);
    continue;
  }

  const amount = want - current;
  info(`${role}: kirim ${formatUnits(amount, 6)} USDC → ${to}`);

  const hash = await wallet.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.error(`GAGAL: transfer ke ${role} revert. tx ${hash}`);
    process.exit(1);
  }
  ok(`${role} terisi — tx ${hash}`);
  await sleep(500);
}

// ── Stage 3: deploy RivoKit's own CPP instances ────────────────────────

step("Tahap 3 — deploy kontrak (instance RivoKit)");

const { initiateSmartContractPlatformClient } = await import(
  "@circle-fin/smart-contract-platform"
);
const scp = initiateSmartContractPlatformClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const loadArtifact = (name) => {
  const a = JSON.parse(readFileSync(resolve(ROOT, `contracts/artifacts/${name}.json`), "utf8"));
  return {
    abiJson: JSON.stringify(a.abi),
    bytecode: typeof a.bytecode === "string" ? a.bytecode : a.bytecode.object,
  };
};

/** Poll until SCP reports the deployed address. */
async function awaitAddress(contractId) {
  for (let i = 0; i < 60; i++) {
    const res = await scp.getContract({ id: contractId });
    const c = res.data?.contract;
    if (c?.contractAddress) return c.contractAddress;
    if (c?.status === "FAILED") throw new Error(`deploy FAILED (${contractId})`);
    await sleep(5000);
  }
  throw new Error(`timeout menunggu alamat untuk ${contractId}`);
}

async function deploy({ name, artifact, constructorParameters, envKey }) {
  const current = readEnv();
  if (current[envKey]) {
    ok(`${name} sudah ter-deploy: ${current[envKey]}`);
    return current[envKey];
  }

  const { abiJson, bytecode } = loadArtifact(artifact);
  info(`deploy ${name}…`);

  let res;
  try {
    res = await scp.deployContract({
      name: `RivoKit ${name}`,
      // Circle requires this to be alphanumeric — no parentheses, no dashes.
      description: `RivoKit deployment of Commerce Payments Protocol ${artifact} pinned commit 3f77761`,
      blockchain: BLOCKCHAIN,
      walletId: current.DEPLOYER_WALLET_ID,
      abiJson,
      bytecode,
      // Omit entirely when the contract takes no constructor args — Circle
      // rejects an empty array with a bare "API parameter invalid".
      ...(constructorParameters.length ? { constructorParameters } : {}),
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
  } catch (e) {
    // Print only the useful fields. NEVER dump e.error: the SDK attaches the
    // full axios config, which includes the Authorization header — printing it
    // leaks CIRCLE_API_KEY into logs and terminal scrollback.
    console.error(`\nGAGAL deploy ${name}`);
    console.error(`  message : ${e?.message}`);
    console.error(`  status  : ${e?.status}`);
    console.error(`  code    : ${e?.code}`);
    console.error(`  url     : ${e?.method} ${e?.url}`);
    const apiErrors = e?.error?.response?.data;
    if (apiErrors) console.error(`  detail  : ${JSON.stringify(apiErrors)}`);
    process.exit(1);
  }

  const contractId = res.data?.contractId;
  info(`contractId ${contractId} — menunggu konfirmasi on-chain…`);
  const address = await awaitAddress(contractId);
  writeEnv({ [envKey]: address });
  ok(`${name} → ${address}`);
  return address;
}

const escrowAddress = await deploy({
  name: "AuthCaptureEscrow",
  artifact: "AuthCaptureEscrow",
  constructorParameters: [],
  envKey: "NEXT_PUBLIC_RIVO_ESCROW_ADDRESS",
});

await deploy({
  name: "ERC3009PaymentCollector",
  artifact: "ERC3009PaymentCollector",
  constructorParameters: [escrowAddress, MULTICALL3],
  envKey: "NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS",
});

await deploy({
  name: "OperatorRefundCollector",
  artifact: "OperatorRefundCollector",
  constructorParameters: [escrowAddress],
  envKey: "NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS",
});

console.log("\nSetup selesai. Alamat tertulis di .env.local.");
