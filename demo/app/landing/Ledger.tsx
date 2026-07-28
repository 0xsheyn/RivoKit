type Status = "proven" | "partial" | "never";

const STATUS_STYLE: Record<Status, { symbol: string; color: string }> = {
  proven: { symbol: "✅", color: "var(--verdigris)" },
  partial: { symbol: "⚠️", color: "var(--sodium)" },
  never: { symbol: "❌", color: "var(--rust)" },
};

const ROWS: Array<{ path: string; status: Status; detail: string }> = [
  {
    path: "Escrow lifecycle · floored swap · multi-chain funding · refund bridge-back",
    status: "proven",
    detail: "proven on Arc",
  },
  { path: "Operator fee 25 bps split at capture, floor intact", status: "proven", detail: "0x7910f1…037420" },
  { path: "Two-wallet mode — floor forwarded merchant → seller", status: "proven", detail: "0x11bf41…559bf4" },
  {
    path: "CPN EUR/SEPA end-to-end → COMPLETED",
    status: "proven",
    detail: "twice · 15 USDC → 12.92 EUR",
  },
  {
    path: "Seller-signed cash-out — seller's own wallet signs the CPN intent",
    status: "proven",
    detail: "0x51e968…f049e7f",
  },
  { path: "CPN BRL / MXN / USD", status: "partial", detail: "requirements + quote + prepare only" },
  { path: "Wallet-side Permit2 approve branch", status: "partial", detail: "written, skipped in that run" },
  { path: "Browser-wallet funding rails", status: "never", detail: "written, never executed on-chain" },
  { path: "Circle Mint redeem", status: "never", detail: "wired, never run once" },
];

export default function Ledger() {
  return (
    <div>
      <p className="eyebrow mb-4">THIS TABLE IS COPIED FROM THE README — WE DON&apos;T HIDE THE ❌ COLUMN.</p>

      {/* <768px: one card per row, status icon large — the honest column
          should never be the thing users have to scroll sideways to find */}
      <div className="flex flex-col gap-3 md:hidden">
        {ROWS.map((r) => {
          const s = STATUS_STYLE[r.status];
          return (
            <div key={r.path} className="hover-step rounded-sm border border-[color:var(--ash)]/15 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[13px] text-[var(--bone)]/85">{r.path}</p>
                <span className="shrink-0 text-[20px]" aria-hidden>
                  {s.symbol}
                </span>
              </div>
              <p className="f-mono mt-2 text-[12px]" style={{ color: s.color }}>
                {r.detail}
              </p>
            </div>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[560px] border-collapse">
          <tbody>
            {ROWS.map((r) => {
              const s = STATUS_STYLE[r.status];
              return (
                <tr key={r.path} className="hover-step border-b border-[color:var(--ash)]/15">
                  <td className="py-3 pr-4 text-[13px] text-[var(--bone)]/85 sm:text-[14px]">{r.path}</td>
                  <td className="f-mono whitespace-nowrap py-3 pl-4 text-right text-[12px]" style={{ color: s.color }}>
                    <span aria-hidden>{s.symbol}</span> {r.detail}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
