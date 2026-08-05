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
import { readEnv } from "./lib/env.mjs";

const env = readEnv();

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`${ok ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
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
    "RPC reachable",
    `chainId=${chainId} (expect ${ARC_TESTNET_CHAIN_ID}), block=${block}`,
  );
} catch (err) {
  record(false, "RPC reachable", String(err?.shortMessage ?? err?.message ?? err));
}

// 2. Key separation + balances.
//
// All three, not two: the demo runs on three raw keys with one job each, and
// the whole point of splitting them is that no single leak is total. `buyer`
// used to be left out of this check, which meant nothing would have noticed if
// it had been set to the same key as another role.
const roles = [
  ["deployer", env.DEPLOYER_PRIVATE_KEY],
  ["seller", env.SELLER_PRIVATE_KEY],
  ["buyer", env.BUYER_PRIVATE_KEY],
];
const addresses = {};

/**
 * Why a key was rejected, WITHOUT echoing it.
 *
 * "not a 32-byte hex private key" is true and useless — it does not say whether
 * the key is short, unprefixed, or carrying a stray character, and a private key
 * is the one value you cannot print to go and look. This describes the shape
 * instead: lengths, prefix, and the POSITION of anything that is not a hex
 * digit, named by class (space, quote, `=`) rather than by value. A real typo
 * shows up as one offending position; a truncated paste shows up as a length.
 *
 * Positions and character classes are not key material. `=` at position 0 is a
 * doubled equals sign in the env file, which is exactly the bug this was written
 * for and would otherwise cost a round trip to find.
 */
function keyShape(key) {
  const body = key.startsWith("0x") ? key.slice(2) : key;
  const bits = [`length ${key.length} (want 66)`, key.startsWith("0x") ? "has 0x" : "NO 0x prefix"];
  const offenders = [];
  for (let i = 0; i < body.length; i++) {
    if (/[0-9a-fA-F]/.test(body[i])) continue;
    const c = body.charCodeAt(i);
    const name =
      c === 32 ? "space" : c === 9 ? "tab" : c === 13 ? "CR" : c === 10 ? "LF"
        : body[i] === '"' || body[i] === "'" ? "quote" : body[i] === "=" ? "'='"
          : `char code ${c}`;
    offenders.push(`${name} at position ${i}`);
  }
  if (offenders.length) bits.push(`non-hex: ${offenders.slice(0, 4).join(", ")}`);
  else if (body.length !== 64) bits.push(`${body.length} hex digits, want 64`);
  return bits.join("; ");
}

for (const [role, key] of roles) {
  if (!key) {
    record(false, `${role} key present`, "not set in .env.local");
    continue;
  }
  let account;
  try {
    account = privateKeyToAccount(key);
  } catch {
    record(false, `${role} key valid`, `not a 32-byte hex private key — ${keyShape(key)}`);
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
      `${role} holds USDC for gas`,
      `${account.address} — ${formatUnits(usdc, TOKEN_DECIMALS)} USDC ` +
        `(native ${formatUnits(native, NATIVE_GAS_DECIMALS)}), ` +
        `${formatUnits(eurc, TOKEN_DECIMALS)} EURC`,
    );
  } catch (err) {
    record(false, `${role} balance readable`, String(err?.shortMessage ?? err?.message ?? err));
  }
}

// Every pair, not just one pair. Checked by ADDRESS rather than by key text so
// the same wallet written two different ways (0x-prefixed or not, different
// case) still counts as the collision it is.
const named = roles.map(([role]) => role).filter((role) => addresses[role]);
const collisions = [];
for (let i = 0; i < named.length; i++) {
  for (let j = i + 1; j < named.length; j++) {
    if (addresses[named[i]].toLowerCase() === addresses[named[j]].toLowerCase()) {
      collisions.push(`${named[i]} = ${named[j]}`);
    }
  }
}
record(
  named.length === roles.length && collisions.length === 0,
  "deployer, seller and buyer are three different wallets (DEPLOYMENT.md §2)",
  named.length !== roles.length
    ? `only ${named.length} of ${roles.length} keys are usable`
    : collisions.length
      ? `SHARED WALLET — ${collisions.join(", ")}; one leak reaches both roles`
      : "separate",
);

// 3. Circle API credentials.
if (!env.CIRCLE_API_KEY) {
  record(false, "CIRCLE_API_KEY is set", "empty");
} else {
  try {
    const res = await fetch("https://api.circle.com/v1/w3s/config/entity", {
      headers: { Authorization: `Bearer ${env.CIRCLE_API_KEY}` },
    });
    record(res.ok, "Circle credentials accepted", `HTTP ${res.status}`);
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
    record(false, "Circle credentials accepted", reason);
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
      `DNS hijacked — the certificate presented belongs to "${cn}", not circle.com. ` +
      `Switch DNS to 1.1.1.1 / 8.8.8.8. DO NOT disable TLS verification: ` +
      `the traffic never reaches Circle, and the API key would be read by whoever intercepts it.`
    );
  }
  return "fetch failed (network or TLS)";
}

record(Boolean(env.CIRCLE_ENTITY_SECRET), "CIRCLE_ENTITY_SECRET diset");
record(Boolean(env.KIT_KEY), "KIT_KEY is set (required for the FX swap)");

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed.` +
    (failed.length ? ` Fix these before running setup:\n  - ${failed.map((f) => f.label).join("\n  - ")}` : " Ready for setup."),
);
process.exit(failed.length ? 1 : 0);
