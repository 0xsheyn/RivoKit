/**
 * Preflight for `npm run setup` — verify prerequisites BEFORE deploying
 * anything or spending gas. Read-only: no transactions are sent.
 *
 * Checks (DEPLOYMENT.md §5):
 *   - Arc RPC reachable and reporting the expected chain ID
 *   - deployer and relayer are distinct addresses
 *   - deployer holds USDC (Arc bills gas in USDC — a dry deployer cannot deploy)
 *   - Circle API credentials are accepted
 *
 *   node scripts/preflight.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  ARC_TESTNET_CHAIN_ID,
  EURC_ADDRESS,
  NATIVE_GAS_DECIMALS,
  TOKEN_DECIMALS,
  USDC_ADDRESS,
} from "../src/constants/arc.ts";
import { arcTransport, sleep } from "../src/lib/rpc.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = resolve(ROOT, ".env.local");

if (!existsSync(ENV)) {
  console.error("GAGAL: .env.local tidak ada. Jalankan: node scripts/sync-env.mjs");
  process.exit(1);
}

const env = {};
for (const line of readFileSync(ENV, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`${ok ? "  OK  " : " GAGAL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const client = createPublicClient({
  chain: arcTestnet,
  transport: arcTransport({
    preferred: env.NEXT_PUBLIC_ARC_RPC_URL ? [env.NEXT_PUBLIC_ARC_RPC_URL] : [],
  }),
});

console.log("Preflight RivoKit — Arc Testnet\n");

// 1. Chain reachable, correct ID.
// NOTE: every RPC call here is sequential and awaited one at a time.
// Arc's public endpoint rate-limits hard — firing these in Promise.all makes
// the reads fail with a bare "RPC Request failed" that looks like an outage
// but is really throttling. Do not "optimise" this into parallel calls.
try {
  const chainId = await client.getChainId();
  const block = await client.getBlockNumber();
  record(
    chainId === ARC_TESTNET_CHAIN_ID,
    "RPC terjangkau",
    `chainId=${chainId} (harap ${ARC_TESTNET_CHAIN_ID}), block=${block}`,
  );
} catch (err) {
  record(false, "RPC terjangkau", String(err?.shortMessage ?? err?.message ?? err));
}

// 2. Key separation + balances.
const roles = [
  ["deployer", env.DEPLOYER_PRIVATE_KEY],
  ["relayer/operator", env.RELAYER_PRIVATE_KEY],
];
const addresses = {};

for (const [role, key] of roles) {
  if (!key) {
    record(false, `kunci ${role} ada`, "tidak diset di .env.local");
    continue;
  }
  let account;
  try {
    account = privateKeyToAccount(key);
  } catch {
    record(false, `kunci ${role} valid`, "bukan private key hex 32-byte");
    continue;
  }
  addresses[role] = account.address;

  try {
    const native = await client.getBalance({ address: account.address });
    await sleep(250);
    const usdc = await client.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    await sleep(250);
    const eurc = await client.readContract({
      address: EURC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    // Native and ERC-20 are the SAME balance seen at different precision
    // (18dp vs 6dp). They should agree; a mismatch means a decimals bug.
    record(
      usdc > 0n,
      `${role} punya USDC untuk gas`,
      `${account.address} — ${formatUnits(usdc, TOKEN_DECIMALS)} USDC ` +
        `(native ${formatUnits(native, NATIVE_GAS_DECIMALS)}), ` +
        `${formatUnits(eurc, TOKEN_DECIMALS)} EURC`,
    );
  } catch (err) {
    record(false, `saldo ${role} terbaca`, String(err?.shortMessage ?? err?.message ?? err));
  }
}

record(
  Boolean(addresses.deployer) &&
    Boolean(addresses["relayer/operator"]) &&
    addresses.deployer !== addresses["relayer/operator"],
  "deployer != relayer (DEPLOYMENT.md §2)",
  addresses.deployer === addresses["relayer/operator"]
    ? "kunci IDENTIK — satu bocor berarti kendali penuh"
    : "terpisah",
);

// 3. Circle API credentials.
if (!env.CIRCLE_API_KEY) {
  record(false, "CIRCLE_API_KEY diset", "kosong");
} else {
  try {
    const res = await fetch("https://api.circle.com/v1/w3s/config/entity", {
      headers: { Authorization: `Bearer ${env.CIRCLE_API_KEY}` },
    });
    record(res.ok, "kredensial Circle diterima", `HTTP ${res.status}`);
  } catch (err) {
    // A TLS failure here is usually NOT Circle's fault. Indonesian ISPs
    // hijack DNS for filtered domains and answer with the internetpositif.id
    // block page, whose certificate does not cover api.circle.com. That
    // surfaces as CERT_HAS_EXPIRED / fetch failed.
    //
    // Never "fix" this by disabling TLS verification: the traffic would reach
    // the interceptor, not Circle, and the API key would be handed to it in
    // the clear.
    const reason = await diagnoseTlsFailure("api.circle.com");
    record(false, "kredensial Circle diterima", reason);
  }
}

async function diagnoseTlsFailure(host) {
  const { connect } = await import("node:tls");
  const cn = await new Promise((resolve) => {
    const socket = connect(
      { host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10000 },
      () => {
        resolve(socket.getPeerCertificate()?.subject?.CN ?? null);
        socket.end();
      },
    );
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      resolve(null);
      socket.destroy();
    });
  });

  if (cn && !cn.includes("circle.com")) {
    return (
      `DNS dibajak — sertifikat yang disodorkan milik "${cn}", bukan circle.com. ` +
      `Ganti DNS ke 1.1.1.1 / 8.8.8.8. JANGAN matikan verifikasi TLS: ` +
      `trafiknya tidak sampai ke Circle, dan kunci API akan terbaca pihak penyaring.`
    );
  }
  return "fetch gagal (jaringan atau TLS)";
}

record(Boolean(env.CIRCLE_ENTITY_SECRET), "CIRCLE_ENTITY_SECRET diset");
record(Boolean(env.KIT_KEY), "KIT_KEY diset (wajib untuk swap FX)");

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} lolos.` +
    (failed.length ? ` Perbaiki dulu sebelum setup:\n  - ${failed.map((f) => f.label).join("\n  - ")}` : " Siap untuk setup."),
);
process.exit(failed.length ? 1 : 0);
