import SectionHeader from "./SectionHeader";
import Rail from "./Rail";

const PRIMITIVES = [
  { name: "Arc", caption: "SETTLEMENT L1 · CHAIN 5042002" },
  { name: "Circle App Kit", caption: "BRIDGE · SWAP · UNIFIED BALANCE" },
  { name: "Commerce Payments", caption: "AUTH / CAPTURE ESCROW" },
  { name: "Circle Payments Network", caption: "SEPA · PIX · SPEI · WIRE" },
];

export default function BuiltOn() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-5 py-16 md:px-16">
      <SectionHeader number="01" title="BUILT ON" />
      <div className="grid grid-cols-2 divide-x divide-[color:var(--ash)]/20 md:grid-cols-4">
        {PRIMITIVES.map((p) => (
          <div key={p.name} className="px-4 py-2 first:pl-0 sm:px-6">
            <p className="f-display text-[22px] text-[var(--bone)] sm:text-[26px]">{p.name}</p>
            <p className="eyebrow mt-2">{p.caption}</p>
          </div>
        ))}
      </div>
      <p className="eyebrow mt-8 text-right">
        RIVOKIT WRITES NO PRIMITIVES FROM SCRATCH — IT COMPOSES · NOT AFFILIATED
      </p>
      <div className="mt-12">
        <Rail />
      </div>
    </section>
  );
}
