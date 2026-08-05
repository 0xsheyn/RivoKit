/**
 * ANSWERED — kept as the record of how, not as an experiment to repeat.
 *
 * It broadcast a CPN EUR/SEPA payment addressed to my own Circle Mint account's
 * EUR wire-in instructions (Bank Frick LI + trackingRef), to ask: **does the
 * Mint EUR balance move?**
 *
 * IT DOES NOT. Payment `1a1cb321…` walked `CRYPTO_FUNDS_PENDING → COMPLETED`
 * and 12 USDC genuinely left the seller's wallet (32.463489 → 20.462647, tx
 * `0xdfcf0e51…91d54f23`), with `customerRefId` carrying the trackingRef intact.
 * The Mint EUR balance sat at 254.49 when it broadcast and was still 254.49 at
 * T+60 minutes, and `/v1/businessAccount/deposits` recorded no new deposit at
 * all — so it was not a slow SEPA credit either. The CPN and Mint sandboxes are
 * simply not connected: CPN's fiat leg is a simulation that stops at CPN's own
 * boundary. That answer cost 12 USDC on 2026-08-01.
 *
 * SO IT REFUSES TO RUN. Not `CONFIRM=` like the scripts whose act is merely
 * irreversible — a prompt is the wrong shape when the finding is already in
 * hand. Re-running buys nothing and spends real testnet balance, and the file
 * survives because deleting it would lose the method behind a claim that
 * `LIMITATIONS.md` and `CLAUDE.md` both lean on.
 *
 * If Circle ever connects the two sandboxes, this becomes worth asking again:
 *
 *   CONFIRM=REPEAT-KNOWN-DEAD-END node scripts/live-cpn-to-mint.mjs [amount]
 */
import { createPublicClient, createWalletClient, erc20Abi, fallback, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createCpnRamp } from "../src/ramp/cpn-ramp.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { sleep } from "../src/lib/rpc.ts";
import {
  ARC_TESTNET_RPC_FALLBACKS, PERMIT2_ADDRESS, USDC_ADDRESS, arcTestnet,
} from "../src/constants/arc.ts";
import { readEnv } from "./lib/env.mjs";

// Before anything: no API call, no balance read, no quote. A guard that runs
// after the first network call has already taught you to read past it.
if (process.env.CONFIRM !== "REPEAT-KNOWN-DEAD-END") {
  console.error(
    "\nRefusing to run — this question is already answered.\n\n" +
      "  CPN reported COMPLETED, 12 USDC left the seller's wallet, and the Mint EUR\n" +
      "  balance did not move: 254.49 at broadcast, 254.49 at T+60min, no deposit\n" +
      "  recorded. The CPN and Mint sandboxes are not connected.\n\n" +
      "  Re-running spends real testnet balance and learns nothing. If Circle has\n" +
      "  since connected them and you mean to ask again:\n\n" +
      "    CONFIRM=REPEAT-KNOWN-DEAD-END node scripts/live-cpn-to-mint.mjs [amount]\n",
  );
  process.exit(1);
}

installCircleDnsPinning();
const env = readEnv();
const AMOUNT = process.argv[2] ?? "12";

const signer = privateKeyToAccount(env.SELLER_PRIVATE_KEY);
const transport = () => fallback(ARC_TESTNET_RPC_FALLBACKS.map((u) => http(u)));
const pub = createPublicClient({ chain: arcTestnet, transport: transport() });

const mint = async (p) => {
  const r = await fetch("https://api-sandbox.circle.com" + p, {
    headers: { Authorization: `Bearer ${env.CIRCLE_RAMP_KEY}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Mint ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data;
};
const eurBalance = async () =>
  (await mint("/v1/businessAccount/balances")).available.find((b) => b.currency === "EUR")?.amount ?? "0";

// ── baseline ────────────────────────────────────────────────────────────
const banks = await mint("/v1/businessAccount/banks/wires");
const eurBank = banks.find((b) => b.bankAddress?.country === "DE") ?? banks[0];
const ins = await mint(`/v1/businessAccount/banks/wires/${eurBank.id}/instructions?currency=EUR`);
const eurBefore = await eurBalance();
const usdcBefore = await pub.readContract({
  address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [signer.address],
});
console.log("BEFORE  Mint EUR:", eurBefore, "| seller USDC:", (Number(usdcBefore) / 1e6).toFixed(6));
console.log("target  IBAN:", ins.beneficiaryBank.accountNumber, "| trackingRef:", ins.trackingRef);

// ── prepare (fresh quote — they live ~60s) ──────────────────────────────
const ramp = createCpnRamp({
  apiKey: env.CIRCLE_CPN_KEY,
  corridor: {
    senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US",
    destinationCountry: "LI", blockchain: "ARC-TESTNET", paymentMethodType: "SEPA",
    sourceCurrency: "USDC", destinationCurrency: "EUR",
  },
});

const ADDR_LI = { street: "Landstrasse 14", city: "Balzers", stateProvince: "LI", country: "LI", postalCode: "9496" };
const ADDR_US = { street: "456 Madison Ave", city: "New York", stateProvince: "NY", country: "US", postalCode: "10001" };

const { quote } = await ramp.quote({ sourceAmount: AMOUNT });
const { payment, transaction } = await ramp.prepare({
  quote,
  beneficiaryAccount: [
    { name: "IBAN", value: ins.beneficiaryBank.accountNumber },
    { name: "RECIPIENT_LEGAL_NAME", value: ins.beneficiary.name },
  ],
  travelRule: [
    { name: "ORIGINATOR_NAME", value: "Rivo Co" },
    { name: "BENEFICIARY_NAME", value: ins.beneficiary.name },
    { name: "ORIGINATOR_ADDRESS", value: ADDR_US },
    { name: "BENEFICIARY_ADDRESS", value: ADDR_LI },
    { name: "ORIGINATOR_ACCOUNT_NUMBER", value: "US1234567890" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_NAME", value: "Rivo Bank" },
    { name: "ORIGINATOR_FINANCIAL_INSTITUTION_ADDRESS", value: ADDR_US },
  ],
  senderAddress: signer.address,
  refundAddress: signer.address,
  useCase: "B2B",
  reasonForPayment: "PMT001",
  customerRefId: ins.trackingRef,
});
console.log(`\nPREPARED ${payment.id} · ${quote.sourceAmount.amount} USDC -> ${quote.destinationAmount.amount} EUR`);

// ── Permit2 allowance ───────────────────────────────────────────────────
const permit = BigInt(transaction.messageToBeSigned.message?.permitted?.amount ?? 0);
const allowance = await pub.readContract({
  address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [signer.address, PERMIT2_ADDRESS],
});
if (allowance < permit) {
  const wallet = createWalletClient({ account: signer, chain: arcTestnet, transport: transport() });
  const hash = await wallet.writeContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, permit],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log("approved Permit2 for", (Number(permit) / 1e6).toFixed(6), "USDC ·", hash);
} else {
  console.log("Permit2 allowance already sufficient:", (Number(allowance) / 1e6).toFixed(6));
}

// ── BROADCAST ───────────────────────────────────────────────────────────
const submitted = await ramp.submit({ paymentId: payment.id, transaction }, signer);
console.log("BROADCASTED transaction", submitted.id, "status", submitted.status);

let last = "";
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  const p = await ramp.status(payment.id);
  if (p.status !== last) { last = p.status; console.log(`  [${i}] ${last}`); }
  if (last === "COMPLETED" || last === "FAILED") break;
}

const full = await ramp.status(payment.id);
console.log("\nfinal:", full.status, "| onChain:", JSON.stringify(full.onChainTransactions ?? []));
console.log("destinationAmount:", JSON.stringify(full.destinationAmount));

// ── did the Mint balance move? ──────────────────────────────────────────
console.log("\nwatching Mint EUR balance (baseline " + eurBefore + ") …");
for (let i = 0; i < 12; i++) {
  const now = await eurBalance();
  console.log(`  [+${i * 15}s] EUR ${now}${now !== eurBefore ? "   <<< MOVED" : ""}`);
  if (now !== eurBefore) break;
  await sleep(15000);
}
const usdcAfter = await pub.readContract({
  address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [signer.address],
});
console.log("seller USDC:", (Number(usdcBefore) / 1e6).toFixed(6), "->", (Number(usdcAfter) / 1e6).toFixed(6));
