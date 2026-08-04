import SectionHeader from "./SectionHeader";
import Integration from "./Integration";

// Verbatim from README > API (src/index.ts is the source of truth) — RIVO_LP.md
// §6.3 forbids inventing snippets, on purpose: a landing page's code is the
// fastest tell for whether the rest of it can be trusted.
const CELLS = [
  {
    title: "Any chain in",
    snippet: "createOrder({ payer, receiver, priceEURMinor, receivingChain, wedge, payoutTo })",
    body: "Payer funds from a USDC balance on any chain; unified balance / CCTP routes it to Arc.",
  },
  {
    title: "Escrow, not custody",
    snippet: 'fund(orderId, { signature }) → "funded"',
    body: "Multi-chain USDC → Arc → gasless ERC-3009 authorize. Funds sit in the contract, never on a server.",
  },
  {
    title: "A floor, enforced on-chain",
    snippet: 'payoutTo: "wallet" → capture → swap, stopLimit = €P',
    body: "The recipient gets ≥ €P or the swap reverts with funds safe. The chain enforces it, not the code.",
  },
  // The bank ending skips the swap entirely — CPN sources only USDC — and a
  // page that showed release() as "capture → swap" was describing half the SDK.
  {
    title: "…or a bank account",
    snippet: 'payoutTo: "bank" → capture → CPN quote pinned to €P → broadcast',
    body: "No swap: CPN sources only USDC, and its own quote locks the euro. One call, escrow to bank.",
  },
  {
    title: "The surplus goes back",
    snippet: "released → { eurcOutMinor, rebateMinor }",
    body: "rebate = max(0, actualOutput − priceEURMinor). Whatever clears above the floor is rebated to the payer.",
  },
  {
    title: "Refunds go home",
    snippet: "refund(orderId) → void + bridge-back",
    body: "USDC returns to the recorded receivingChain — never stranded on Arc.",
  },
  {
    title: "Events, not polling",
    snippet: "on(\"paid_out\", handler)",
    body: "funding_pending · funded · released · payout_pending · paid_out · refund_pending · refunded.",
  },
  // Seven cells in a three-column grid left two dead slots on the last row —
  // and a grid that stops mid-row reads as a list someone abandoned. These two
  // fill it, and they are not filler: the timeout rule and the second read are
  // the two things integrators get wrong first. Both come from the same
  // verified surface as the rest — `WEDGES` in orchestrator/policy.ts, and
  // `refreshPayout` in the SDK's own API list.
  {
    title: "Timeouts you don't set",
    snippet: 'wedge: "contractor_payout" | "physical_demo"',
    body: "Timeout is not a parameter. Strong proof auto-captures for the recipient; weak proof reclaims for the payer.",
  },
  {
    title: "A second read closes the row",
    snippet: "refreshPayout(orderId)",
    body: "A broadcast returns before the tx is mined, so a payout row is born pending. A webhook or this call confirms it.",
  },
];

export default function Capabilities() {
  return (
    <section id="capabilities" className="mx-auto w-full max-w-[1440px] scroll-mt-[92px] px-5 py-8 md:scroll-mt-[100px] md:px-16">
      <SectionHeader number="03" title="WHAT RIVOKIT ACTUALLY DOES" />
      <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-12">
        <h2 className="f-display text-[34px] leading-[0.95] text-[var(--bone)] md:col-span-6 md:text-[44px]">
          A handful of calls, one integration.
        </h2>
        <p className="text-[15px] leading-relaxed text-[var(--bone)]/80 md:col-span-6 md:col-start-8">
          The platform calls a few functions instead of becoming a payment company. Every snippet below is the real API
          surface — <span className="f-mono text-[var(--sodium)]">createRivoKit</span>,{" "}
          <span className="f-mono text-[var(--sodium)]">createCpnPayoutRail</span> and{" "}
          <span className="f-mono text-[var(--sodium)]">createCpnRamp</span>, nothing invented.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-sm bg-[color:var(--ash)]/15 sm:grid-cols-2 md:grid-cols-3">
        {CELLS.map((c) => (
          <div key={c.title} className="hover-step hover-accent bg-[var(--ink-raised)] p-5">
            <p className="f-display text-[19px] text-[var(--bone)]">{c.title}</p>
            <pre className="f-mono mt-3 overflow-x-auto whitespace-pre-wrap break-all text-[12.5px] leading-relaxed text-[var(--sodium)]">
              {c.snippet}
            </pre>
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--bone)]/70">{c.body}</p>
          </div>
        ))}
      </div>

      <Integration />
    </section>
  );
}
