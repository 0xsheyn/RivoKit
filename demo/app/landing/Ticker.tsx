// Every hash carries the leg it belongs to. Two different runs settled here —
// the CPN EUR/SEPA pair at €12.92 and the seller-signed cash-out at €12.94 —
// and a bare hash next to the wrong figure would quietly merge them.
const ITEMS = [
  "ORDER · 15.00 USDC → €12.92",
  "stopLimit €12.92",
  "fee 25 bps GROSSED ONTO PAYER",
  "rebate → payer",
  "CAPTURE + FEE SPLIT · tx 0x7910f1…037420",
  "CPN EUR/SEPA COMPLETED ×2",
  "SELLER-SIGNED CASH-OUT · 15 USDC → €12.94 · tx 0x51e968…f049e7f",
];

function Segment() {
  return (
    <span className="flex shrink-0 items-center">
      {ITEMS.map((item, i) => (
        <span key={i} className="flex items-center">
          <span>{item}</span>
          <span className="mx-6 text-[var(--sodium)]">·</span>
        </span>
      ))}
    </span>
  );
}

export default function Ticker() {
  return (
    <div className="ticker-viewport overflow-hidden border-y border-[color:var(--ash)]/20 bg-[var(--ink-raised)] py-3">
      <div className="ticker-track f-mono flex w-max whitespace-nowrap text-[11px] text-[var(--ash)]" style={{ height: "34px", alignItems: "center" }}>
        <Segment />
        <Segment />
      </div>
    </div>
  );
}
