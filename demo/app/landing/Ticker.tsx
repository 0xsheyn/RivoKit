// Every figure carries the leg it belongs to. Several different runs are named
// here — the bank-bound order at €10.00, the standalone EUR/SEPA cash-outs at
// €12.92, the wallet-signed one at €12.94, the USD/WIRE payment — and a bare
// hash next to the wrong figure would quietly merge them. "ORDER · 15.00 USDC →
// €12.92" did exactly that: it labelled a standalone cash-out as an order.
const ITEMS = [
  "ORDER → BANK IN ONE release() · 11.751140 USDC → €10.00",
  "CPN EUR/SEPA COMPLETED · CPN USD/WIRE COMPLETED",
  "fee 25 bps GROSSED ONTO PAYER",
  "rebate → payer · +0.474498 USDC READ OFF THE CHAIN",
  "CAPTURE + FEE SPLIT · tx 0x7910f1…037420",
  "WALLET-SIGNED CASH-OUT · 15 USDC → €12.94 · tx 0x51e968…f049e7f",
  "COMPLETED = CPN REPORTED IT · NOT A BANK STATEMENT",
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
    <div className="ticker-viewport overflow-hidden border-y border-[color:var(--ash)]/20 bg-[var(--ink-raised)] py-4">
      <div className="ticker-track f-mono flex w-max whitespace-nowrap text-[11px] text-[var(--ash)]" style={{ height: "34px", alignItems: "center" }}>
        <Segment />
        <Segment />
      </div>
    </div>
  );
}
