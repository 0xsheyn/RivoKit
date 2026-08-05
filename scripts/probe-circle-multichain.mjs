/**
 * Does ONE Circle wallet carry ONE address across the four chains a payer can
 * fund from?
 *
 * Phase 17 proved a Developer-Controlled `EOA` wallet signs recoverably, which
 * is what lets it stand in for the demo's buyer. But the buyer funds from
 * Avalanche Fuji, Base Sepolia, Ethereum Sepolia or Polygon Amoy, and the wallet
 * that was proven only exists on Arc. Whether that is a one-call fix or a
 * redesign turns on a single fact:
 *
 *   Same wallet set + same derivation index → same address on every EVM chain?
 *
 * If YES, a Circle-wallet buyer has one identity everywhere, and `receivingChain`
 * for refunds keeps meaning what it means today. If NO, every chain gives the
 * buyer a different address, and refund routing has to be remapped — a much
 * larger change that should be discovered here, for free, and not later.
 *
 * The evidence that suggests YES is wallet set `e88528d5…`, whose two EOAs each
 * appear on five chains under one address. But that set was created with all its
 * chains AT ONCE. The set under test already exists with Arc only, so its other
 * chains would be added AFTERWARDS — and nothing observed so far says a later
 * call reuses the earlier derivation index rather than taking a fresh one. That
 * is the actual open question, and only creating them answers it.
 *
 * READ-ONLY BY DEFAULT. With no arguments it inventories what the entity already
 * has and reports which source chains are missing, touching nothing.
 *
 *   node scripts/probe-circle-multichain.mjs                 # what exists today?
 *   node scripts/probe-circle-multichain.mjs <walletSetId>   # focus one set
 *   node scripts/probe-circle-multichain.mjs <walletSetId> --create
 *
 * `--create` is the only mutating path. It moves no funds and sends no
 * transaction — a wallet is a key derivation, not a balance. It is still not
 * free of consequence: Circle wallets and wallet sets CANNOT be deleted, so a
 * careless run leaves permanent litter in the entity. It creates at most one
 * wallet per missing chain and refuses to touch a chain that already has one.
 */
import { createCircleClient } from "./lib/circle.mjs";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();
const env = readEnv();
const circle = createCircleClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

const ARC = "ARC-TESTNET";

/**
 * Circle's blockchain codes for the four chains in `demo/lib/source-chain.ts`.
 *
 * These are API codes, not App Kit chain names — `AVAX-FUJI` here is
 * `Avalanche_Fuji` there, and the two vocabularies never meet. Kept next to the
 * source-chain key so a reader can line the two tables up; if a row is ever
 * added to `SOURCE_CHAINS`, this table is the second place to touch.
 *
 * Amoy is included even though its CCTP burn reverts (see the row's own note in
 * `source-chain.ts`). The question here is address derivation, which has nothing
 * to do with whether a bridge works — and leaving it out would leave the one
 * chain with NO wallet anywhere in the entity untested.
 */
const SOURCE_CHAINS = [
  { key: "fuji", code: "AVAX-FUJI", label: "Avalanche Fuji" },
  { key: "base", code: "BASE-SEPOLIA", label: "Base Sepolia" },
  { key: "sepolia", code: "ETH-SEPOLIA", label: "Ethereum Sepolia" },
  { key: "amoy", code: "MATIC-AMOY", label: "Polygon Amoy" },
];

let failures = 0;
/** The one address the source chains agreed on, once `--create` has run. */
let settled = null;
const ok = (pass, label, detail = "") => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  · ${detail}` : ""}`);
};
const step = (s) => console.log(`\n${s}\n${"─".repeat(s.length)}`);

/** Every wallet in the entity, following Circle's page cursor to the end. */
async function allWallets() {
  const out = [];
  let after = "";
  for (let page = 0; page < 20; page++) {
    const res = await circle.listWallets(`?pageSize=50${after}`);
    const batch = res?.wallets ?? [];
    out.push(...batch);
    // Circle paginates by cursor, not offset: ask for what comes AFTER the last
    // id seen. A short page means the end — asking again would loop forever on
    // an entity whose wallet count is an exact multiple of the page size.
    if (batch.length < 50) break;
    after = `&pageAfter=${batch[batch.length - 1].id}`;
  }
  return out;
}

async function main() {
  /* ── 1. What the entity holds right now ────────────────────────────────── */

  step("1 — every wallet in this entity, grouped by set and address");

  const wallets = await allWallets();
  console.log(`  ${wallets.length} wallet(s)\n`);

  // set → address → [{chain, id, accountType}]. Address is the grouping key
  // because that is the claim under test: one address, many chains.
  const sets = new Map();
  for (const w of wallets) {
    const bySet = sets.get(w.walletSetId) ?? new Map();
    const byAddr = bySet.get(w.address) ?? [];
    byAddr.push(w);
    bySet.set(w.address, byAddr);
    sets.set(w.walletSetId, bySet);
  }

  for (const [setId, byAddr] of sets) {
    console.log(`  set ${setId}`);
    for (const [address, list] of byAddr) {
      const chains = list.map((w) => w.blockchain).sort();
      const types = [...new Set(list.map((w) => w.accountType ?? "?"))].join("/");
      console.log(`    ${address}  ${types}  ${chains.length} chain(s): ${chains.join(", ")}`);
    }
    console.log("");
  }

  /* ── 2. The set under test ─────────────────────────────────────────────── */

  const args = process.argv.slice(2);
  const create = args.includes("--create");
  const anchorId = args.find((a) => !a.startsWith("--"));

  // A WALLET id, not a wallet set id. A set is a key-derivation parent that can
  // hold many wallets at many indices — set `9475af57…` alone holds three Arc
  // EOAs — and only one of them is the buyer candidate. Naming the set would
  // leave the anchor ambiguous, and an ambiguous anchor is how you end up
  // comparing a new address against the wrong old one and calling it a mismatch.
  if (!anchorId) {
    console.log(
      "\nRead-only pass done. To check one wallet's source-chain coverage, name it:\n" +
        "  node scripts/probe-circle-multichain.mjs <walletId>\n" +
        "Pick the id from the inventory above — it is the wallet the buyer would become.",
    );
    return;
  }

  const anchor = (await circle.getWallet(anchorId))?.wallet;
  if (!anchor) {
    console.error(`\n  No wallet ${anchorId} in this entity.`);
    failures += 1;
    return;
  }
  const setId = anchor.walletSetId;
  const anchorAddress = anchor.address;

  step(`2 — source-chain coverage for ${anchorAddress}`);
  console.log(`  anchor  ${anchor.id}  ${anchor.blockchain}  accountType=${anchor.accountType}`);
  console.log(`  set     ${setId}\n`);

  if (anchor.blockchain !== ARC) {
    console.log(`  note: the anchor lives on ${anchor.blockchain}, not ${ARC}. Comparison still holds.`);
  }

  // Siblings are found by ADDRESS, not by set: within a set each derivation
  // index is a different address, and it is the address that has to repeat
  // across chains for the "one identity" claim to mean anything.
  const have = new Map(
    (sets.get(setId)?.get(anchorAddress) ?? [anchor]).map((w) => [w.blockchain, w]),
  );
  const missing = SOURCE_CHAINS.filter((c) => !have.has(c.code));

  for (const c of SOURCE_CHAINS) {
    const w = have.get(c.code);
    console.log(
      w
        ? `  present  ${c.label.padEnd(18)} ${c.code.padEnd(14)} ${w.id}  ${w.address}`
        : `  MISSING  ${c.label.padEnd(18)} ${c.code}`,
    );
  }

  if (missing.length === 0) {
    step("3 — verdict");
    ok(true, "all four source chains already exist under one address", anchorAddress);
  } else if (!create) {
    console.log(
      `\n  ${missing.length} chain(s) missing. Nothing was changed. To create them:\n` +
        `    node scripts/probe-circle-multichain.mjs ${anchor.id} --create\n\n` +
        "  That is permanent — Circle wallets cannot be deleted — but it moves no\n" +
        "  funds and sends no transaction.",
    );
    return;
  } else {
    /* ── 3. Create the missing ones, then check the address ──────────────── */

    step(`3 — creating ${missing.length} wallet(s) in set ${setId}`);
    console.log(`  ${missing.map((c) => c.code).join(", ")}\n`);

    // One call for all of them rather than one call each. If Circle allocates a
    // derivation index per REQUEST rather than per wallet, a single call is the
    // arrangement most likely to keep them together — and if the addresses come
    // back different anyway, that rules out request batching as the cause and
    // leaves the answer unambiguous.
    let created;
    try {
      created = (
        await circle.createWallets({
          walletSetId: setId,
          blockchains: missing.map((c) => c.code),
          count: 1,
          accountType: "EOA",
        })
      )?.wallets ?? [];
    } catch (e) {
      ok(false, "Circle accepted the create request", String(e?.message ?? e).slice(0, 200));
      return;
    }

    ok(created.length === missing.length, `${missing.length} wallet(s) came back`, `got ${created.length}`);

    step("4 — one address, or one per chain?");
    for (const w of created) {
      console.log(`  ${w.blockchain.padEnd(14)} ${w.address}  ${w.id}  accountType=${w.accountType}`);
      // Asked for explicitly in the request above, but an SCA that came back
      // anyway would sign ERC-1271 and could not be the buyer. Checked rather
      // than assumed.
      ok(w.accountType === "EOA", `${w.blockchain.padEnd(14)} is EOA`, `accountType=${w.accountType}`);
    }

    // THE question. Not "did it match the anchor" — a set holds many derivation
    // indices, and `createWallets` picks the next free index FOR THAT CHAIN
    // rather than the index you happened to name. So a new address here is
    // ordinary. What would be fatal is the addresses differing FROM EACH OTHER,
    // because that would mean the key is derived per chain and a buyer has no
    // single identity to fund or to refund.
    const addresses = new Set(created.map((w) => w.address.toLowerCase()));
    ok(addresses.size === 1, "all four chains returned ONE address", [...addresses].join(", "));
    settled = [...addresses][0];

    if (settled !== anchorAddress.toLowerCase()) {
      console.log(
        `\n  Note: that address is not the anchor's. ${anchorAddress}\n` +
          "  sits at a different derivation index, and the request cannot name one —\n" +
          "  each chain got its own next-free index, which happened to be the same\n" +
          "  index on all four. The multichain buyer is therefore the address above,\n" +
          "  not the anchor. Re-run probe-circle-eoa-sign.mjs against its Arc wallet\n" +
          "  before building on it: being EOA is a property of the wallet, and this\n" +
          "  probe has not signed anything.",
      );
    }
  }

  /* ── Verdict ───────────────────────────────────────────────────────────── */

  step("verdict");
  if (failures === 0) {
    console.log(
      `  One address — ${settled ?? anchorAddress} — across Arc and every source chain.\n` +
        "  A Circle-wallet buyer therefore has ONE identity to fund and ONE address\n" +
        "  for refunds to return to, exactly as the raw-key buyer does today.\n\n" +
        "  Still unproven, and not provable here: that any USDC can actually MOVE\n" +
        "  from those chains through this wallet. Gas on all four is the chain's own\n" +
        "  native token, not USDC — the wallet has none of it anywhere.",
    );
  } else {
    console.log(
      `  ${failures} check(s) failed.\n` +
        "  Addresses differing from EACH OTHER is the serious outcome: it means the\n" +
        "  key is derived per chain, so a buyer has a different identity on every one.\n" +
        "  That is not a bug to fix — it is a different design, in which refund\n" +
        "  routing has to map `receivingChain` → address per buyer.",
    );
  }
}

await main();
// `exitCode` rather than `exit()` — the DNS-pinned agent still holds handles,
// and killing the process while it does trips a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
