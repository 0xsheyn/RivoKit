import SectionHeader from "./SectionHeader";
import Rail from "./Rail";

// Verbatim from README > API (src/index.ts is the source of truth) — RIVO_LP.md
// §6.3 forbids inventing snippets, on purpose: a landing page's code is the
// fastest tell for whether the rest of it can be trusted.
const CELLS = [
  {
    title: "Any chain in",
    snippet: "createOrder({ payer, receiver, priceEURMinor, receivingChain, wedge })",
    body: "Payer funds from a USDC balance on any chain; unified balance / CCTP routes it to Arc.",
  },
  {
    title: "Escrow, not custody",
    snippet: 'fund(orderId, { signature }) → "funded"',
    body: "Multi-chain USDC → Arc → gasless ERC-3009 authorize. Funds sit in the contract, never on a server.",
  },
  {
    title: "A floor, enforced on-chain",
    snippet: "release(orderId, proof) → capture → swap, stopLimit = €P",
    body: "The recipient gets ≥ €P or the swap reverts with funds safe. The chain enforces it, not the code.",
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
    snippet: "on(\"released\", handler)",
    body: "funding_pending · funded · released · refund_pending · refunded. Wire it to your ledger.",
  },
];

export default function Capabilities() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-5 py-16 md:px-16">
      <SectionHeader number="02" title="WHAT RIVOKIT ACTUALLY DOES" />
      <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-12">
        <h2 className="f-display text-[34px] leading-[0.95] text-[var(--bone)] md:col-span-6 md:text-[44px]">
          Six calls, one integration.
        </h2>
        <p className="text-[15px] leading-relaxed text-[var(--bone)]/80 md:col-span-6 md:col-start-8">
          The platform calls a handful of functions instead of becoming a payment company. Every snippet below is the
          real API surface — <span className="f-mono text-[var(--sodium)]">createRivoKit</span> and{" "}
          <span className="f-mono text-[var(--sodium)]">createCpnRamp</span>, nothing invented.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-sm bg-[color:var(--ash)]/15 sm:grid-cols-2 md:grid-cols-3">
        {CELLS.map((c) => (
          <div key={c.title} className="hover-step bg-[var(--ink-raised)] p-5">
            <p className="f-display text-[19px] text-[var(--bone)]">{c.title}</p>
            <pre className="f-mono mt-3 overflow-x-auto whitespace-pre-wrap break-all text-[12.5px] leading-relaxed text-[var(--sodium)]">
              {c.snippet}
            </pre>
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--bone)]/70">{c.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-12">
        <Rail />
      </div>
    </section>
  );
}
