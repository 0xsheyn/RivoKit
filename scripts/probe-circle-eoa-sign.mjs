/**
 * Can a Circle Developer-Controlled wallet produce a signature that a
 * COUNTERPARTY can recover?
 *
 * This is the one question that decides whether the demo's buyer and seller can
 * move from raw private keys onto Circle wallets. Both roles sign EIP-712 typed
 * data that something else then recovers:
 *
 *   buyer  → ERC-3009 `ReceiveWithAuthorization`; USDC ecrecovers `from`
 *   seller → CPN's payment intent; the settlement contract ecrecovers the sender
 *
 * An `EOA` wallet returns a 65-byte ECDSA signature and recovers correctly. An
 * `SCA` wallet returns an ERC-1271 signature, which is validated by CALLING the
 * account contract — it recovers to nothing, and both counterparties above would
 * reject it. The account type is fixed when the wallet is created and cannot be
 * changed afterwards, so this is worth knowing before anything is built on it.
 *
 * READ-ONLY BY DEFAULT. With no arguments it inspects the wallets already in the
 * entity and reports their account types, touching nothing. Signing needs a
 * wallet id; creating one needs `--create` and is the only mutating path here.
 *
 *   node scripts/probe-circle-eoa-sign.mjs              # what do I already have?
 *   node scripts/probe-circle-eoa-sign.mjs <walletId>   # sign + recover with it
 *   node scripts/probe-circle-eoa-sign.mjs --create     # make an Arc EOA, then test it
 *
 * No funds move and no transaction is sent — signing typed data is off-chain, so
 * the wallet under test does not need a balance.
 */
import { recoverTypedDataAddress } from "viem";
import { createCircleClient } from "./lib/circle.mjs";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from "../src/constants/arc.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();
const env = readEnv();
const circle = createCircleClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

const ARC = "ARC-TESTNET";
let failures = 0;

const ok = (pass, label, detail = "") => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  · ${detail}` : ""}`);
};
const step = (s) => console.log(`\n${s}\n${"─".repeat(s.length)}`);

/* ── The two shapes that actually matter ─────────────────────────────── */

/**
 * Circle wants the CANONICAL EIP-712 JSON, which declares `EIP712Domain` in
 * `types` alongside the primary type. viem, wagmi and MetaMask all derive that
 * entry from the `domain` object and let you omit it — so a payload copied
 * straight out of this codebase is rejected with
 * `156026: there is extra data provided in the message (0 < 4)`. The numbers
 * are the giveaway: 4 fields found in `domain`, 0 declared for them.
 *
 * Derived from the domain rather than hardcoded, so a domain that omits
 * `version` (Permit2 does) does not declare a field it has no value for —
 * which would fail the same validator from the other direction.
 */
const DOMAIN_FIELD_TYPES = {
  name: "string",
  version: "string",
  chainId: "uint256",
  verifyingContract: "address",
  salt: "bytes32",
};

const withDomainType = (td) => ({
  ...td,
  types: {
    EIP712Domain: Object.keys(td.domain).map((k) => ({ name: k, type: DOMAIN_FIELD_TYPES[k] })),
    ...td.types,
  },
});

/** viem derives EIP712Domain itself and rejects being handed one. */
const forRecovery = ({ types: { EIP712Domain: _drop, ...types }, ...rest }) => ({ ...rest, types });

/**
 * The real ERC-3009 shape the buyer signs, with placeholder values. The VALUES
 * are irrelevant to this test; the DOMAIN is not — a domain carrying both a
 * chainId and a verifyingContract is what a wallet has to hash correctly, and
 * getting that wrong produces a signature that recovers to a stranger rather
 * than failing outright.
 */
const erc3009 = (from) => ({
  domain: { name: "USDC", version: "2", chainId: ARC_TESTNET_CHAIN_ID, verifyingContract: USDC_ADDRESS },
  types: {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "ReceiveWithAuthorization",
  message: {
    from,
    to: "0x0000000000000000000000000000000000000001",
    value: "1000000",
    validAfter: "0",
    validBefore: "4102444800",
    nonce: "0x" + "11".repeat(32),
  },
});

/**
 * A Permit2-shaped intent, which is the family CPN's `messageToBeSigned`
 * belongs to. Included alongside the flat ERC-3009 shape because this one has a
 * NESTED struct, and nested types are hashed differently — a wallet that
 * handles the flat case can still get this one wrong.
 */
const permit2ish = (owner) => ({
  domain: { name: "Permit2", chainId: ARC_TESTNET_CHAIN_ID, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  types: {
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    PermitTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "PermitTransferFrom",
  message: {
    permitted: { token: USDC_ADDRESS, amount: "1000000" },
    spender: owner,
    nonce: "1",
    deadline: "4102444800",
  },
});

// Wrapped in a function so the read-only pass can `return` instead of calling
// `process.exit()`. Exiting while the DoH agent still holds handles trips a
// libuv assertion on Windows — the probe's own output was fine and the crash
// after it was pure noise, which is the worst kind of failure to leave in a
// diagnostic tool.
async function main() {

/* ── 1. What is already in the entity ────────────────────────────────── */

step("1 — wallets already in this entity");

const roles = new Map(
  [
    [env.OPERATOR_WALLET_ID, "OPERATOR — relays every escrow call"],
    [process.env.MERCHANT_WALLET_ID, "MERCHANT — settlement hop, holds EURC"],
  ].filter(([id]) => id),
);

const wallets = (await circle.listWallets(`?blockchain=${ARC}`))?.wallets ?? [];
if (wallets.length === 0) {
  console.log("  (none on Arc Testnet)");
} else {
  for (const w of wallets) {
    const role = roles.get(w.id);
    console.log(
      `  ${w.id}  ${w.address}  accountType=${w.accountType ?? "?"}  ${w.name ?? ""}` +
        (role ? `\n      ↳ ${role}` : ""),
    );
  }
}
const eoaCount = wallets.filter((w) => w.accountType === "EOA").length;
console.log(`\n  ${eoaCount} of ${wallets.length} are EOA — only those can sign recoverably.`);

// The operator and merchant only ever EXECUTE contracts, which an SCA does
// perfectly well. So their type is not a problem to fix — it is stated here
// only so it is not mistaken for one when the list above is read.
for (const [id, role] of roles) {
  const w = wallets.find((x) => x.id === id);
  if (w && w.accountType !== "EOA") {
    console.log(`  note: ${role.split(" —")[0]} is ${w.accountType}. Fine — it executes contracts, it never signs for recovery.`);
  }
}

/* ── 2. Pick or create the wallet under test ─────────────────────────── */

const arg = process.argv[2];
let target;

if (arg === "--create") {
  step("2 — creating a fresh EOA wallet on Arc Testnet");
  // A wallet set is the key-derivation parent. Reuse the first one rather than
  // making another: wallet sets cannot be deleted, and a probe should not leave
  // litter in an account it does not own.
  const sets = (await circle.listWalletSets())?.walletSets ?? [];
  const walletSetId = sets[0]?.id ?? (await circle.createWalletSet("rivokit-probe")).walletSet.id;
  console.log(`  wallet set ${walletSetId}${sets[0] ? " (existing)" : " (created)"}`);

  const created = await circle.createWallets({
    walletSetId,
    blockchains: [ARC],
    count: 1,
    // The whole point of the probe. Circle defaults to SCA on some chains, so
    // this is stated rather than assumed.
    accountType: "EOA",
  });
  target = created.wallets[0];
  console.log(`  created ${target.id}  ${target.address}  accountType=${target.accountType}`);
} else if (arg) {
  step(`2 — wallet under test: ${arg}`);
  target = (await circle.getWallet(arg))?.wallet;
  if (!target) {
    console.error(`\nNo wallet ${arg} in this entity.`);
    failures += 1;
    return;
  }
  console.log(`  ${target.address}  accountType=${target.accountType}  blockchain=${target.blockchain}`);
} else {
  console.log(
    "\nRead-only pass done. To test signing, re-run with a wallet id, or with\n" +
      "--create to make a fresh Arc EOA first:\n" +
      "  node scripts/probe-circle-eoa-sign.mjs <walletId>\n" +
      "  node scripts/probe-circle-eoa-sign.mjs --create",
  );
  return;
}

/* ── 3. Sign, and try to recover ─────────────────────────────────────── */

step("3 — sign typed data, then recover the signer");

ok(target.accountType === "EOA", "wallet is EOA", `accountType=${target.accountType}`);
if (target.accountType !== "EOA") {
  console.log(
    "\n  An SCA wallet returns an ERC-1271 signature. It is a valid signature —\n" +
      "  it simply does not recover, so USDC and CPN would both reject it. The\n" +
      "  recovery checks below are expected to fail; that is the finding, not a bug.",
  );
}

const address = target.address;

for (const [label, typedData] of [
  ["ERC-3009 ReceiveWithAuthorization (the buyer's shape)", erc3009(address)],
  ["Permit2 PermitTransferFrom (the seller's family, nested struct)", permit2ish(address)],
]) {
  console.log(`\n  ${label}`);
  let signature;
  try {
    const res = await circle.signTypedData({ walletId: target.id, data: withDomainType(typedData) });
    signature = res?.signature;
  } catch (e) {
    ok(false, "Circle accepted the sign request", String(e?.message ?? e).slice(0, 160));
    continue;
  }

  ok(Boolean(signature), "a signature came back", signature ? `${signature.slice(0, 12)}…` : "");
  if (!signature) continue;
  // 65 bytes = r,s,v. Anything longer is an ERC-1271 blob, which is the answer
  // by itself even before recovery is attempted.
  ok(signature.length === 132, "65 bytes (ECDSA, not an ERC-1271 blob)", `${(signature.length - 2) / 2} bytes`);

  try {
    const recovered = await recoverTypedDataAddress({ ...forRecovery(withDomainType(typedData)), signature });
    ok(
      recovered.toLowerCase() === address.toLowerCase(),
      "recovers to the wallet's own address",
      `recovered ${recovered}`,
    );
  } catch (e) {
    ok(false, "recovery succeeded", String(e?.message ?? e).slice(0, 120));
  }
}

/* ── Verdict ─────────────────────────────────────────────────────────── */

step("verdict");
if (failures === 0) {
  console.log(
    "  This wallet can stand in for the demo buyer and seller.\n" +
      "  Both signatures recover to its own address, which is exactly what USDC's\n" +
      "  ERC-3009 and CPN's settlement contract each do before accepting one.",
  );
} else {
  console.log(
    `  ${failures} check(s) failed. This wallet cannot replace a raw key for the\n` +
      "  buyer or seller role. If the account type is SCA, that is the cause and it\n" +
      "  cannot be changed on an existing wallet — create a new one with --create,\n" +
      "  which asks for EOA explicitly.",
  );
}

}

await main();
// `exitCode` rather than `exit()`: the process leaves when its own handles are
// done, instead of being killed while the DNS-pinned agent still holds some.
process.exitCode = failures === 0 ? 0 : 1;
