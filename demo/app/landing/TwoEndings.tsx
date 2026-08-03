import SectionHeader from "./SectionHeader";

/**
 * `payoutTo` is the structural idea of this SDK, and it was reaching the page
 * only as two adjacent cells in the capabilities grid — a detail, when it is
 * actually the decision every integration has to make first.
 *
 * Condensed from ARCHITECTURE.md > The two settlement paths. The skipped swap
 * is the part worth the space: it looks like a shortcut and is the opposite of
 * one.
 */
const PATHS = [
  {
    key: "wallet",
    snippet: 'payoutTo: "wallet"',
    tag: "DEFAULT",
    color: "var(--verdigris)",
    headline: "Ends at floored EURC on Arc.",
    steps: ["capture", "swap USDC→EURC, stopLimit = €P", "EURC in the recipient's wallet"],
    body:
      "Cashing out stays the recipient's own decision, made later over an accumulated balance and driven independently through createCpnRamp. The floor is held by the chain: a swap that cannot meet it reverts, funds safe.",
  },
  {
    key: "bank",
    snippet: 'payoutTo: "bank"',
    tag: "REACHES A BANK",
    color: "var(--sodium)",
    headline: "Ends in a local bank account, in one call.",
    steps: ["capture", "CPN quote pinned to €P", "broadcast — no second manual step"],
    body:
      "The currency follows the corridor. Order size comes from the rail that will execute it, never from the swap's spread — PayoutRail.estimate() exists because a shortfall computed the other way surfaces only after the escrow is captured.",
  },
];

export default function TwoEndings() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-5 py-8 md:px-16">
      <SectionHeader number="04" title="WHERE THE MONEY ENDS UP" />

      <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-12">
        <h2 className="f-display text-[34px] leading-[0.95] text-[var(--bone)] md:col-span-6 md:text-[44px]">
          One field decides the ending.
        </h2>
        <p className="text-[15px] leading-relaxed text-[var(--bone)]/80 md:col-span-6 md:col-start-8">
          Fixed once, at <span className="f-mono text-[var(--sodium)]">createOrder</span> — not renegotiated at
          release, not left to the payer. Everything downstream follows from it, including whether a swap runs at all.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-sm bg-[color:var(--ash)]/15 md:grid-cols-2">
        {PATHS.map((p) => (
          <div key={p.key} className="hover-step hover-accent bg-[var(--ink-raised)] p-6">
            <div className="flex flex-wrap items-center gap-3">
              <pre className="f-mono text-[13px]" style={{ color: p.color }}>
                {p.snippet}
              </pre>
              <span className="eyebrow rounded-full border border-[color:var(--ash)]/30 px-2 py-0.5">{p.tag}</span>
            </div>
            <p className="f-display mt-4 text-[22px] leading-tight text-[var(--bone)]">{p.headline}</p>

            <ol className="mt-5 space-y-2">
              {p.steps.map((s, i) => (
                <li key={s} className="f-mono flex items-start gap-3 text-[12.5px] text-[var(--bone)]/80">
                  <span className="shrink-0" style={{ color: p.color }}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>

            <p className="mt-5 text-[13px] leading-relaxed text-[var(--bone)]/70">{p.body}</p>
          </div>
        ))}
      </div>

      {/* The single most misread thing about the bank path, said where the two
          paths sit side by side rather than left for the reader to notice. */}
      <div className="mt-6 border-l-2 border-[color:var(--sodium)] pl-4">
        <p className="f-display text-[19px] text-[var(--bone)]">The bank path runs no swap — and that is not a shortcut.</p>
        <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-[var(--bone)]/75">
          CPN sources <span className="f-mono text-[var(--sodium)]">only</span> USDC — verified against the live API,
          not read from a doc. EURC cannot be off-ramped through it at all, so converting first would pay a spread to
          reach a currency that is immediately spent to reach another one. The CPN quote pins the euro the recipient
          receives, exactly as <span className="f-mono">stopLimit</span> did. And the check that the quote clears the
          guaranteed price stays in the SDK: a host-supplied rail quotes and broadcasts, it never decides whether the
          recipient was paid enough.
        </p>
      </div>
      <p className="eyebrow mt-8 text-right">
        A BANK ORDER MUST PAY THE WALLET THAT SIGNS PERMIT2 — THE OFF-RAMP SPENDS WHAT CAPTURE PRODUCED
      </p>
    </section>
  );
}
