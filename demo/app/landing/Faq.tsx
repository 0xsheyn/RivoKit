import SectionHeader from "./SectionHeader";
import Accordion, { type QA } from "./Accordion";

/**
 * The last thing before "install it", and deliberately the only section that
 * answers in prose.
 *
 * Every question here is one nothing above answers. The previous set asked
 * about custody, the FX guarantee, who triggers a payout and whether the fiat
 * leg is real — all of which now have proper homes in §04, §05 and §05.1, so
 * asking them again here would be a second, softer answer competing with the
 * first. These are the operational questions instead: which chain, whose gas,
 * what breaks, and what happens when it does.
 *
 * Sources, in order: CLAUDE.md (Arc's gas decimals), demo/lib/source-chain.ts
 * (the chain table and Amoy's disabled reason), demo/lib/rivokit.server.ts (the
 * fee and the operator gas floor), PROOFS.md (the recovery run),
 * demo/app/Marketplace.tsx (the authorization window), ARCHITECTURE.md (the
 * PayoutRail seam), README.md (the contract deployment), LIMITATIONS.md (the
 * pending payout row).
 */
const QUESTIONS: readonly QA[] = [
  {
    q: "Why Arc, and not a chain everyone already uses?",
    a: "Because USDC is the native gas token there, so a payer never has to acquire a second asset in order to move the first one — which is the friction that makes “just pay in stablecoins” collapse in practice. It has a cost: the same balance carries two decimalisations, 18 as gas and 6 as an ERC-20, a factor of 10¹² that has to be right in every conversion. Arc also runs its compliance checks as chain-level precompiles rather than contract code. Neither of those exists on a local EVM, which is why a Foundry fork test proves nothing here and why every claim on this page was run against the real testnet instead.",
  },
  {
    q: "Which chains can the payer pay from?",
    a: "Ethereum Sepolia, Base Sepolia and Avalanche Fuji, over either CCTP or a Gateway unified balance — the payer holds USDC where they hold it. Fuji is the default for exactly one reason: its hard finality is a single confirmation, so its worst case equals its best case. Base and Ethereum normally settle in seconds through Fast Transfer, but fall back to roughly 15–19 minutes if the Fast Transfer allowance is exhausted. Polygon Amoy has a row in the same table and is shown disabled rather than hidden: approve lands, the CCTP burn reverts, and the identical code path from Sepolia works — so it is Amoy's problem, not the SDK's.",
  },
  {
    q: "Who pays for gas?",
    a: "The operator. The payer signs an ERC-3009 authorization in their own wallet and never needs to hold Arc gas; the operator relays it and pays for every escrow call — authorize, capture, void, refund. That is a real running cost, so it is recovered by a 25 bps fee grossed onto the payer, never taken out of the recipient's floor. And when the operator's own gas drops below a configured floor, new orders are refused outright rather than accepted and stranded halfway.",
  },
  {
    q: "What happens if the swap cannot meet the floor?",
    a: "It reverts, and that is the design rather than a failure mode to apologise for. The capture already happened, so the USDC is sitting in the settlement wallet and nothing was sold at a bad rate; retrying once the rate recovers wins, which is exactly what scripts/live-recovery.mjs does against the live chain. On the bank path there is no swap to revert, so the equivalent is RivoKit refusing to broadcast a corridor quote that would deliver less than the guaranteed price — the money simply stays where it is.",
  },
  {
    q: "What if the payer never signs?",
    a: "The ERC-3009 authorization carries a window — one hour after checkout in the demo — and once it passes the escrow refuses to collect. From then on the only thing the order supports is being closed. That refusal is what an ESTIMATION_ERROR from the relay actually means, which is worth knowing because it reads like a bug and is not one. Nothing was taken from the payer either: USDC a funding rail already delivered is sitting in their own address on Arc, and paying from there is the fastest route on a fresh order.",
  },
  {
    q: "Can I use a payout rail that isn't CPN?",
    a: "Yes. PayoutRail is a six-method interface — limits, estimate, ready, quote, submit, status — and createCpnPayoutRail is one implementation of it. Two rules survive whoever writes the next one. limits() has to be a live read, because corridor minimums are enforced from the destination side and drift with FX; 11 USDC was refused on a corridor that accepted 12 the same day. And the check that a quote clears the guaranteed price stays in the SDK: a rail quotes and broadcasts, it never decides whether the recipient was paid enough.",
  },
  {
    q: "Is the escrow contract yours, or Circle's?",
    a: "The protocol is Circle's Commerce Payments Protocol. The deployment is ours — RivoKit's own four instances on Arc Testnet, not the sample addresses, all source-verified as a full match on the explorer so anyone can read what is actually running. The wiring between them is asserted by check-cpp.mjs rather than assumed, because four correct contracts pointed at each other incorrectly is a failure that looks exactly like success until money moves.",
  },
  {
    q: "Why does a payout row start out pending?",
    a: "Because the broadcast returns before the transfer is mined, so at the moment the row is written the Arc hash does not exist yet — and a database constraint rightly refuses to mark a row confirmed without one. A second read closes it: refreshPayout, driven by a webhook or a poll, or the reconcile sweep for whatever a crashed run left behind. A host running neither will accumulate stale pending rows, which is why a scheduled reconciliation sits on the roadmap above rather than in the proven column.",
  },
];

export default function Faq() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-5 py-8 md:px-16">
      <SectionHeader number="07" title="QUESTIONS BEFORE YOU CLONE IT" />

      <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-12">
        <h2 className="f-display text-[34px] leading-[0.95] text-[var(--bone)] md:col-span-6 md:text-[44px]">
          The operational ones.
        </h2>
        <p className="text-[15px] leading-relaxed text-[var(--bone)]/80 md:col-span-6 md:col-start-8">
          Which chain, whose gas, what breaks — and what the system does when it does. What is proven and what is not
          has its own section above, with the hashes attached.
        </p>
      </div>

      <Accordion items={QUESTIONS} />
    </section>
  );
}
