/**
 * Identity check for the Commerce Payments Protocol contracts on Arc Testnet.
 *
 * Circle's reference app (circlefin/arc-ecommerce-payments) documents live
 * addresses for AuthCaptureEscrow and ERC3009PaymentCollector. Bytecode merely
 * EXISTING at an address proves nothing about what that code is — so this
 * compares the on-chain runtime bytecode against the pinned artifacts before
 * RivoKit routes any money through them.
 *
 *   node scripts/check-cpp.mjs
 */
import { readFileSync } from "node:fs";
import { createPublicClient, toFunctionSelector } from "viem";
import { arcTestnet } from "viem/chains";
import { arcTransport, sleep } from "../src/lib/rpc.ts";

/** Addresses documented by circlefin/arc-ecommerce-payments. */
const KNOWN = {
  AuthCaptureEscrow: "0xa5b4fa1890619cf03b8d6b11e0c680345b1881d8",
  ERC3009PaymentCollector: "0x01e39d4a0b8ffeac8ae1618dbf316d15a8ee867c",
};

const artifact = (name) =>
  JSON.parse(readFileSync(`contracts/artifacts/${name}.json`, "utf8"));

/** Foundry artifacts nest bytecode under .object; tolerate both shapes. */
const hexOf = (v) => (typeof v === "string" ? v : v?.object) ?? null;

const client = createPublicClient({ chain: arcTestnet, transport: arcTransport() });

let allMatch = true;

for (const [name, address] of Object.entries(KNOWN)) {
  const art = artifact(name);
  const expected = hexOf(art.deployedBytecode) ?? hexOf(art.runtimeBytecode);

  const onchain = await client.getCode({ address });
  const size = onchain && onchain !== "0x" ? (onchain.length - 2) / 2 : 0;

  console.log(`\n${name}`);
  console.log(`  alamat        : ${address}`);
  console.log(`  bytecode      : ${size ? `${size} byte` : "KOSONG"}`);

  if (!expected) {
    console.log("  artefak       : tidak memuat deployedBytecode — tak bisa dibandingkan");
    console.log(`  fungsi di ABI : ${art.abi.filter((f) => f.type === "function").length}`);
    allMatch = false;
  } else if (!size) {
    console.log("  VERDIKT       : tidak ter-deploy");
    allMatch = false;
  } else {
    // Metadata hash at the tail differs per build; compare the body too.
    const exact = onchain.toLowerCase() === expected.toLowerCase();
    const body = (h) => h.toLowerCase().slice(0, -106);
    const bodyMatch = body(onchain) === body(expected);
    console.log(`  keccak onchain: ${keccak256(onchain).slice(0, 18)}…`);
    console.log(`  keccak artefak: ${keccak256(expected).slice(0, 18)}…`);
    console.log(
      `  VERDIKT       : ${
        exact
          ? "COCOK PERSIS — kontrak identik dengan artefak ter-pin"
          : bodyMatch
            ? "COCOK (hanya metadata hash berbeda — build ulang source yang sama)"
            : "TIDAK COCOK — JANGAN dipakai"
      }`,
    );
    if (!exact && !bodyMatch) allMatch = false;
  }

  await sleep(400);
}

// The refund collector is deployed per-app; it has no canonical address.
const refund = artifact("OperatorRefundCollector");
console.log(
  `\nOperatorRefundCollector\n  belum ter-deploy — bytecode siap di artefak ` +
    `(${refund.abi.filter((f) => f.type === "function").length} fungsi di ABI)`,
);

console.log(
  `\n${allMatch ? "Dua kontrak inti terverifikasi — aman dipakai ulang." : "Ada yang tidak terverifikasi — periksa sebelum lanjut."}`,
);
process.exit(allMatch ? 0 : 1);
