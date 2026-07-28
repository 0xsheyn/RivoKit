/**
 * Parity check: does our off-chain getPaymentInfoHash match the deployed
 * escrow's getHash, for arbitrary inputs?
 *
 * This is the single highest-risk computation in Phase 1. The hash is both the
 * escrow's state key and the ERC-3009 nonce, so a mismatch means funds that
 * authorize but can never be captured. Randomised inputs, not one lucky case.
 *
 *   node scripts/check-hash.mjs
 */
import { createPublicClient, getAddress, toHex } from "viem";
import { arcTestnet } from "viem/chains";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS, EURC_ADDRESS } from "../src/constants/arc.ts";
import { getPaymentInfoHash, getPayerAgnosticHash, ZERO_ADDRESS } from "../src/escrow/payment-info.ts";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();
const ESCROW = getAddress(env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS);

const GET_HASH_ABI = [
  {
    type: "function",
    name: "getHash",
    stateMutability: "view",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: [
          { name: "operator", type: "address" },
          { name: "payer", type: "address" },
          { name: "receiver", type: "address" },
          { name: "token", type: "address" },
          { name: "maxAmount", type: "uint120" },
          { name: "preApprovalExpiry", type: "uint48" },
          { name: "authorizationExpiry", type: "uint48" },
          { name: "refundExpiry", type: "uint48" },
          { name: "minFeeBps", type: "uint16" },
          { name: "maxFeeBps", type: "uint16" },
          { name: "feeReceiver", type: "address" },
          { name: "salt", type: "uint256" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
];

const client = createPublicClient({ chain: arcTestnet, transport: arcTransport() });

const randAddress = () => {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return getAddress(toHex(bytes));
};
const randBigInt = (bits) => {
  const bytes = new Uint8Array(bits / 8);
  crypto.getRandomValues(bytes);
  return BigInt(toHex(bytes));
};
const randInt = (max) => Math.floor(Math.random() * max);

/** Deliberately includes edge cases: zero fields, max-width values. */
const CASES = [
  {
    label: "realistic demo values",
    info: {
      operator: getAddress(env.OPERATOR_ADDRESS),
      payer: getAddress(env.DEPLOYER_ADDRESS),
      receiver: getAddress(env.MERCHANT_ADDRESS),
      token: USDC_ADDRESS,
      maxAmount: 20_280_000n,
      preApprovalExpiry: 1_800_000_000,
      authorizationExpiry: 1_800_086_400,
      refundExpiry: 1_800_604_800,
      minFeeBps: 0,
      maxFeeBps: 25,
      feeReceiver: ZERO_ADDRESS,
      salt: 1n,
    },
  },
  {
    label: "all zeros / minimum",
    info: {
      operator: ZERO_ADDRESS,
      payer: ZERO_ADDRESS,
      receiver: ZERO_ADDRESS,
      token: ZERO_ADDRESS,
      maxAmount: 0n,
      preApprovalExpiry: 0,
      authorizationExpiry: 0,
      refundExpiry: 0,
      minFeeBps: 0,
      maxFeeBps: 0,
      feeReceiver: ZERO_ADDRESS,
      salt: 0n,
    },
  },
  {
    label: "lebar maksimum tiap tipe",
    info: {
      operator: randAddress(),
      payer: randAddress(),
      receiver: randAddress(),
      token: EURC_ADDRESS,
      maxAmount: 2n ** 120n - 1n,
      preApprovalExpiry: 2 ** 48 - 1,
      authorizationExpiry: 2 ** 48 - 1,
      refundExpiry: 2 ** 48 - 1,
      minFeeBps: 10_000,
      maxFeeBps: 10_000,
      feeReceiver: randAddress(),
      salt: 2n ** 256n - 1n,
    },
  },
];

// Plus randomised cases.
for (let i = 0; i < 4; i++) {
  CASES.push({
    label: `acak #${i + 1}`,
    info: {
      operator: randAddress(),
      payer: randAddress(),
      receiver: randAddress(),
      token: randAddress(),
      maxAmount: randBigInt(112),
      preApprovalExpiry: randInt(2 ** 40),
      authorizationExpiry: randInt(2 ** 40),
      refundExpiry: randInt(2 ** 40),
      minFeeBps: randInt(10_001),
      maxFeeBps: randInt(10_001),
      feeReceiver: randAddress(),
      salt: randBigInt(256),
    },
  });
}

console.log(`Parity getHash — escrow ${ESCROW}\n`);

let failures = 0;
for (const { label, info } of CASES) {
  const local = getPaymentInfoHash(info, ARC_TESTNET_CHAIN_ID, ESCROW);
  const onchain = await client.readContract({
    address: ESCROW,
    abi: GET_HASH_ABI,
    functionName: "getHash",
    args: [info],
  });
  const match = local.toLowerCase() === onchain.toLowerCase();
  if (!match) failures++;
  console.log(`${match ? "  OK  " : " FAIL "}  ${label}`);
  if (!match) {
    console.log(`         lokal   ${local}`);
    console.log(`         onchain ${onchain}`);
  }
  await sleep(400);
}

// The payer-agnostic variant must equal the on-chain hash of the same struct
// with payer zeroed — that is literally what the collector computes.
const base = CASES[0].info;
const agnosticLocal = getPayerAgnosticHash(base, ARC_TESTNET_CHAIN_ID, ESCROW);
const agnosticOnchain = await client.readContract({
  address: ESCROW,
  abi: GET_HASH_ABI,
  functionName: "getHash",
  args: [{ ...base, payer: ZERO_ADDRESS }],
});
const agnosticMatch = agnosticLocal.toLowerCase() === agnosticOnchain.toLowerCase();
if (!agnosticMatch) failures++;
console.log(`${agnosticMatch ? "  OK  " : " FAIL "}  ERC-3009 nonce (payer zeroed)`);

// And it must DIFFER from the payer-bound hash, or zeroing achieved nothing.
const distinct = agnosticLocal.toLowerCase() !== getPaymentInfoHash(base, ARC_TESTNET_CHAIN_ID, ESCROW).toLowerCase();
if (!distinct) failures++;
console.log(`${distinct ? "  OK  " : " FAIL "}  nonce differs from the payer-bound hash`);

console.log(
  `\n${CASES.length + 2 - failures}/${CASES.length + 2} passed.` +
    (failures ? " Hash computation does NOT match — do not proceed." : " Off-chain hashes verified."),
);
process.exit(failures ? 1 : 0);
