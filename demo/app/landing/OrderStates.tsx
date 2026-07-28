import SectionHeader from "./SectionHeader";
import Rail from "./Rail";
import InView from "./InView";

const STATES = [
  {
    key: "funded",
    amount: "15.00 USDC",
    color: "var(--sodium)",
    label: "HELD ON ARC · AWAITING RELEASE HOOK",
    caption: "funded",
  },
  {
    key: "released",
    amount: "€12.92",
    color: "var(--verdigris)",
    label: "SWAPPED · FLOOR MET · PAID OUT",
    caption: "released",
    // The capture that split the 25 bps fee with the floor still intact — the
    // tx that actually proves *this* state. (The seller-signed cash-out hash
    // belongs to a later, separate leg; it lives in the ledger, not here.)
    tx: "0x7910f1…037420",
    txUrl: "https://testnet.arcscan.app/tx/0x7910f15984c10fe929d3e642a84ca3be2c86d3727076fb3d57552899e0037420",
  },
  {
    key: "refunded",
    amount: "15.00 USDC",
    color: "var(--rust)",
    label: "VOIDED · BRIDGED BACK TO ORIGIN CHAIN",
    caption: "refunded",
  },
];

export default function OrderStates() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-5 py-16 md:px-16">
      <SectionHeader number="03" title="ONE ORDER, ITS STATES" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {STATES.map((s) =>
          s.key === "released" ? (
            <InView
              key={s.key}
              className="rounded-sm border-b-2 border-[color:var(--ash)]/20 bg-[var(--ink-raised)] p-6"
              activeClassName="stamp-in"
            >
              <p className="f-mono text-[32px]" style={{ color: s.color }}>
                {s.amount}
              </p>
              <p className="eyebrow mt-3">{s.label}</p>
              <p className="f-display mt-6 text-[18px] text-[var(--bone)]/70">{s.caption}</p>
              {s.tx && (
                <a
                  href={s.txUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="f-mono mt-2 block text-[11px] text-[var(--verdigris)] underline decoration-dotted underline-offset-4"
                >
                  tx {s.tx}
                </a>
              )}
            </InView>
          ) : (
            <div key={s.key} className="rounded-sm border-b-2 border-[color:var(--ash)]/20 bg-[var(--ink-raised)] p-6">
              <p className="f-mono text-[32px]" style={{ color: s.color }}>
                {s.amount}
              </p>
              <p className="eyebrow mt-3">{s.label}</p>
              <p className="f-display mt-6 text-[18px] text-[var(--bone)]/70">{s.caption}</p>
            </div>
          ),
        )}
      </div>

      <p className="eyebrow mt-8 text-right">
        MODE: ESCROW (AUTH→CAPTURE) · ALT: DIRECT (CHARGE) · TIMEOUT DERIVED FROM WEDGE
      </p>

      <div className="mt-12">
        <Rail />
      </div>
    </section>
  );
}
