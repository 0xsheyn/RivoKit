import SectionHeader from "./SectionHeader";

/**
 * From LIMITATIONS.md > Roadmap, ordered the same way: by what closes a
 * structural hole, not by what adds surface.
 *
 * This is also the ONE place BRL/PIX and MXN/SPEI may be named. They are
 * implemented — corridor config, per-rail beneficiary and travel-rule fields,
 * quotes — and left unexercised on purpose, so listing them anywhere else as a
 * gap, a ⚠️, or a limitation states something untrue about the codebase. The
 * roadmap is where "implemented, deliberately not exercised" is the honest
 * frame. USD/WIRE is not in this group: it was a target and it settled.
 */
const GROUPS: Array<{ title: string; note: string; items: string[] }> = [
  {
    title: "Next",
    note: "finish proving what is already written",
    items: [
      "A human clicking the wallet prompts. Every answer already has a branch and a test — what is missing is the click, and no server key may stand in for it.",
      "A bank-payout button in the marketplace UI. canPayoutToBank() already says which listings clear the corridor minimum.",
      "A durable public endpoint, so a webhook subscription outlives the process that created it.",
      "A scheduled reconciliation, closing the stale-row gap for standalone cash-outs whose webhook never arrives.",
    ],
  },
  {
    title: "Later",
    note: "widen the reach once the above holds",
    items: [
      "CPN BRL/PIX and MXN/SPEI. Implemented — corridor config, beneficiary and travel-rule fields, quotes — and unexercised on purpose: they add breadth, not depth.",
      "Direct unit coverage for the network-facing modules. Two real defects have already hidden there, so this is remediation, not tidiness.",
    ],
  },
  {
    title: "Gated on things outside the code",
    note: "not a schedule anyone here controls",
    items: [
      "One real payment on mainnet into an account you control — the only thing that turns the fiat leg from reported into observed. EUR/SEPA, about €10–12.",
      "Mainnet: audit, key timelock/multisig, legal review, OFI onboarding.",
    ],
  },
];

export default function Roadmap() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-5 py-8 md:px-16">
      <SectionHeader number="06" title="WHAT'S NEXT" />

      <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-12">
        <h2 className="f-display text-[34px] leading-[0.95] text-[var(--bone)] md:col-span-6 md:text-[44px]">
          Ordered by what closes a hole.
        </h2>
        <p className="text-[15px] leading-relaxed text-[var(--bone)]/80 md:col-span-6 md:col-start-8">
          Nothing here is a promise. It is what the ledger above says is still missing, in the order that would make
          the project more true rather than merely larger.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-sm bg-[color:var(--ash)]/15 md:grid-cols-3">
        {GROUPS.map((g) => (
          <div key={g.title} className="hover-step hover-accent bg-[var(--ink-raised)] p-5">
            <p className="f-display text-[22px] text-[var(--bone)]">{g.title}</p>
            <p className="eyebrow mt-1.5">{g.note}</p>
            <ol className="mt-5 space-y-4">
              {g.items.map((item, i) => (
                <li key={item} className="flex items-start gap-3">
                  <span className="f-mono shrink-0 text-[12px] text-[var(--sodium)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[13px] leading-relaxed text-[var(--bone)]/75">{item}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}
