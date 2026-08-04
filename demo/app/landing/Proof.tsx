import SectionHeader from "./SectionHeader";
import Ledger from "./Ledger";
import NotThis from "./NotThis";
import Reproduce from "./Reproduce";

export default function Proof() {
  return (
    <section id="proof" className="mx-auto w-full max-w-[1440px] scroll-mt-[92px] px-5 py-8 md:scroll-mt-[100px] md:px-16">
      <SectionHeader number="05" title="WHAT'S PROVEN, WHAT ISN'T" />

      {/* Nothing but evidence lives here now: the ceiling, the table, what this
          is not, and how to check it. The six-question accordion that used to
          open this section answered things §04 and §05.1 already answer, in a
          softer voice, directly above a table of hashes — it moved to §07. */}
      <div className="mb-10">
        <h2 className="f-display text-[34px] text-[var(--bone)] sm:text-[44px]">Proof, not claims.</h2>
        {/* No `max-w` here, and none on any left-aligned prose in this section.
            The section rule above and the ledger grid below both run the full
            1312px column; a paragraph stopping at 672px left a third of the
            page empty down its right side, which reads as a broken layout
            rather than as a reading measure. The measure is the column.

            Centred copy is the exception and keeps its cap — Hero, ThesisBand
            and CtaInstall — because a centred block has no ragged edge to
            explain: the space falls symmetrically on both sides, which is the
            shape it was asking for. */}
        <p className="mt-2 text-[15px] leading-relaxed text-[var(--bone)]/75">
          Almost every row below is a transaction hash you can open or a payment id Circle will confirm — next to what
          it does not establish. The two that are neither say so under the grid. Copied from PROOFS.md and
          LIMITATIONS.md, including where they say no.
        </p>
      </div>

      <Ledger />

      {/* Both are subsections, not sections: they belong beside the table they
          qualify, and a numbered slot each would cost more page than either is
          worth on its own. */}
      <NotThis />
      <Reproduce />
    </section>
  );
}
