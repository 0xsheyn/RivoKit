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
  // This group had four items and now has two. The two that left — a human
  // clicking the wallet prompts, and a human pressing the marketplace's bank
  // button — were both done and both verified by use; they moved up into the
  // proof grid. What is left is not code at all: neither of these can be closed
  // by writing something, which is why the note now says "hosting" rather than
  // "finish proving".
  {
    title: "Next",
    note: "the last two gaps, and neither is code",
    items: [
      "A durable public endpoint, so a webhook subscription outlives the process that created it. The route already exports HEAD — which is what Circle validates with — so what is missing is a host, plus a Console step that can only ever be manual.",
      "A scheduled reconciliation, closing the stale-row gap for standalone cash-outs whose webhook never arrives. The sweep itself can be written today; the scheduler waits on the endpoint above.",
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
    <section id="roadmap" className="mx-auto w-full max-w-[1440px] scroll-mt-[92px] px-5 py-8 md:scroll-mt-[100px] md:px-16">
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
