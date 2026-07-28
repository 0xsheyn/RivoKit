const ITEMS = [
  "ORDER · 15.00 USDC → €12.92",
  "stopLimit €12.92",
  "fee 25 bps GROSSED ONTO PAYER",
  "rebate → payer",
  "CPN EUR/SEPA COMPLETED",
  "tx 0x51e968…f049e7f",
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
