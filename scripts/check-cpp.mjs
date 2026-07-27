/**
 * Post-deploy verification for RivoKit's Commerce Payments Protocol instances.
 *
 * Deployment reporting an address proves only that a transaction landed. What
 * matters is the WIRING: each collector stores its escrow as an immutable and
 * rejects every other caller, so a collector bound to the wrong escrow would be
 * permanently useless — and would silently point at Circle's shared deployment
 * instead of RivoKit's.
 *
 *   node scripts/check-cpp.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, getAddress } from "viem";
import { arcTestnet } from "viem/chains";
import { arcTransport, sleep } from "../src/lib/rpc.ts";

if (!existsSync(".env.local")) {
  console.error("FAILED: .env.local is missing. Run: node scripts/setup.mjs");
  process.exit(1);
}
const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

const ESCROW = env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS;
const COLLECTOR = env.NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS;
const REFUND = env.NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS;

/** Circle's shared sample deployment — RivoKit must NOT be wired to this. */
const CIRCLE_SAMPLE_ESCROW = "0xa5b4fa1890619cf03b8d6b11e0c680345b1881d8";

const client = createPublicClient({ chain: arcTestnet, transport: arcTransport() });

const results = [];
const check = (ok, label, detail) => {
  results.push(ok);
  console.log(`${ok ? "  OK  " : " FAIL "}  ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log("RivoKit deployment verification — Arc Testnet\n");

// 1. Code is actually present at each address.
for (const [name, address] of Object.entries({
  AuthCaptureEscrow: ESCROW,
  ERC3009PaymentCollector: COLLECTOR,
  OperatorRefundCollector: REFUND,
})) {
  if (!address) {
    check(false, `${name} address`, "empty in .env.local");
    continue;
  }
  const code = await client.getCode({ address });
  const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  check(size > 0, `${name} has bytecode`, `${address} — ${size} bytes`);
  await sleep(300);
}

// 2. The escrow deployed its own TokenStore implementation in the constructor.
const tokenStoreImpl = await client.readContract({
  address: ESCROW,
  abi: [
    {
      type: "function",
      name: "tokenStoreImplementation",
      inputs: [],
      outputs: [{ type: "address" }],
      stateMutability: "view",
    },
  ],
  functionName: "tokenStoreImplementation",
});
check(
  tokenStoreImpl && tokenStoreImpl !== "0x0000000000000000000000000000000000000000",
  "escrow has a TokenStore implementation",
  tokenStoreImpl,
);
await sleep(300);

// 3. THE DECISIVE CHECK — each collector's immutable escrow must be ours.
const collectorEscrowAbi = [
  {
    type: "function",
    name: "authCaptureEscrow",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
];

for (const [name, address] of Object.entries({
  ERC3009PaymentCollector: COLLECTOR,
  OperatorRefundCollector: REFUND,
})) {
  const wired = await client.readContract({
    address,
    abi: collectorEscrowAbi,
    functionName: "authCaptureEscrow",
  });
  const isOurs = getAddress(wired) === getAddress(ESCROW);
  const isCircles = getAddress(wired) === getAddress(CIRCLE_SAMPLE_ESCROW);
  check(
    isOurs,
    `${name} is bound to the RivoKit escrow`,
    isOurs
      ? wired
      : isCircles
        ? `${wired} — this is the CIRCLE SAMPLE escrow, not ours`
        : `${wired} — not the RivoKit escrow`,
  );
  await sleep(300);
}

// 4. Collector roles: Payment = 0, Refund = 1.
const typeAbi = [
  {
    type: "function",
    name: "collectorType",
    inputs: [],
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
  },
];
for (const [name, address, expected] of [
  ["ERC3009PaymentCollector", COLLECTOR, 0],
  ["OperatorRefundCollector", REFUND, 1],
]) {
  const t = await client.readContract({ address, abi: typeAbi, functionName: "collectorType" });
  check(
    Number(t) === expected,
    `${name} has the right type`,
    `collectorType=${t} (expect ${expected} = ${expected === 0 ? "Payment" : "Refund"})`,
  );
  await sleep(300);
}

const failed = results.filter((r) => !r).length;
console.log(
  `\n${results.length - failed}/${results.length} passed.` +
    (failed ? " Something is wrong — DO NOT route funds." : " Deployment verified."),
);
process.exit(failed ? 1 : 0);
