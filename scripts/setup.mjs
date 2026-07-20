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

console.log(
  "\nTahap 1 selesai. Tahap 2 (deploy kontrak) belum dijalankan — " +
    "wallet deployer perlu USDC untuk gas lebih dulu.",
);
