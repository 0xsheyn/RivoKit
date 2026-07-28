import SectionHeader from "./SectionHeader";
import Rail from "./Rail";

const STATS = [
  { value: "280", caption: "UNIT TESTS GREEN · 19 FILES · NO CREDENTIALS" },
  { value: "4 / 4", caption: "CPP CONTRACTS SOURCE-VERIFIED, FULL MATCH ON ARC" },
  { value: "25 bps", caption: "OPERATOR FEE · GROSSED ONTO PAYER · NEVER TOUCHES THE FLOOR" },
];

export default function Numbers() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-5 py-16 md:px-16">
      <SectionHeader number="04" title="THE NUMBERS" />
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
        {STATS.map((s) => (
          <div key={s.caption}>
            <p className="f-mono text-[52px] text-[var(--bone)] sm:text-[64px]">{s.value}</p>
            <p className="eyebrow mt-2">{s.caption}</p>
          </div>
        ))}
      </div>
      <p className="eyebrow mt-10 text-right">
        MEASURED ON ARC TESTNET · CHAIN 5042002 · 0 PRIVATE KEYS HELD BY RIVOKIT
      </p>
      <div className="mt-12">
        <Rail />
      </div>
    </section>
  );
}
