import SectionHeader from "./SectionHeader";
import Accordion from "./Accordion";
import Ledger from "./Ledger";

export default function Proof() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-5 py-16 md:px-16">
      <SectionHeader number="05" title="PROOF, NOT CLAIMS" />

      <div className="mb-10">
        <h2 className="f-display text-[34px] text-[var(--bone)] sm:text-[44px]">Proof, not claims.</h2>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-[var(--bone)]/75">
          The uncomfortable questions, answered the way the README answers them — including where it says no.
        </p>
      </div>

      <Accordion />

      <div className="mt-16">
        <Ledger />
      </div>
    </section>
  );
}
