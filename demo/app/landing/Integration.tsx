/**
 * The code a host actually writes, in one block.
 *
 * The capabilities grid above shows six one-line snippets and never once shows
 * them assembled — so the page claimed "one integration" without ever showing
 * the integration. This is the shape of `demo/lib/rivokit.server.ts`, the same
 * composition `scripts/live-sdk.mjs` drives against Arc Testnet, with the
 * demo's environment plumbing left out and nothing else changed.
 *
 * Every identifier here is real: `wedge` values come from `WEDGES` in
 * `orchestrator/policy.ts`, the release proof kinds from `RELEASE_PROOF_KINDS`,
 * and the dependency names from `createRivoKit`'s own parameter. A landing page
 * that invents an API is the fastest way to prove the rest of it untrustworthy.
 */
const CODE = `import { createRivoKit, createCpnPayoutRail } from "rivokit";

// RivoKit opens no connections and holds no keys. Everything that needs a
// credential is injected — which is what keeps the host the party of record.
const kit = createRivoKit({
  store, escrow, fx, bridge,
  fund,        // needs the payer's signature and a funding rail
  payRebate,   // returns the surplus; omit it and the recipient keeps it
  payoutRail,  // omit it and payoutTo: "bank" is refused at createOrder
  config: {
    chainId, escrowAddress, operator, token,
    refundCollector, settlementAddress,
    feeBps: 25,        // grossed onto the payer, never onto the floor
  },
});

const order = await kit.createOrder({
  payer, receiver,
  priceEURMinor: 1000n,          // €10.00 — bigint minor units, never a float
  receivingChain: "Ethereum_Sepolia", // where a refund goes home to
  wedge: "contractor_payout",
  payoutTo: "bank",
});

kit.on("paid_out", ({ orderId }) => ledger.settle(orderId));

await kit.fund(order.id, { signature });          // ERC-3009, signed by the payer
await kit.release(order.id, { kind: "milestone" }); // capture → quote → broadcast`;

export default function Integration() {
  return (
    <div className="mt-14">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3 border-b border-[color:var(--ash)]/20 pb-3">
        <span className="eyebrow">03.1 —— THE WHOLE INTEGRATION</span>
        <span className="eyebrow">NO KEYS · NO CONNECTIONS · NO CUSTODY</span>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
        <div className="md:col-span-5">
          <h3 className="f-display text-[26px] leading-tight text-[var(--bone)] sm:text-[32px]">
            This is the file you write.
          </h3>
          <p className="mt-4 text-[14px] leading-relaxed text-[var(--bone)]/75">
            Not a sketch of one. It is the shape of{" "}
            <span className="f-mono text-[var(--sodium)]">demo/lib/rivokit.server.ts</span> — the same composition the
            live scripts drive against Arc Testnet — with the demo&apos;s environment plumbing removed.
          </p>
          <p className="mt-4 text-[14px] leading-relaxed text-[var(--bone)]/75">
            Three injections carry the weight, and each is a thing RivoKit must not hold:{" "}
            <span className="f-mono text-[var(--bone)]">fund</span> needs the payer&apos;s signature,{" "}
            <span className="f-mono text-[var(--bone)]">payRebate</span> needs a settlement wallet&apos;s signer, and{" "}
            <span className="f-mono text-[var(--bone)]">payoutRail</span> needs a payout key plus the beneficiary&apos;s
            PII. Leave the last one out and a build simply has no payout capability — refused at{" "}
            <span className="f-mono">createOrder</span> rather than half-wired.
          </p>
        </div>

        <div className="md:col-span-7">
          <pre className="f-mono overflow-x-auto rounded-sm bg-[var(--ink-raised)] p-5 text-[12px] leading-relaxed text-[var(--bone)]/90 sm:text-[12.5px]">
            {CODE}
          </pre>
        </div>
      </div>
    </div>
  );
}
