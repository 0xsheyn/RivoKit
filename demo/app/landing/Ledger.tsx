type Status = "proven" | "partial" | "never";

const STATUS_STYLE: Record<Status, { symbol: string; color: string }> = {
  proven: { symbol: "✅", color: "var(--verdigris)" },
  partial: { symbol: "⚠️", color: "var(--sodium)" },
  never: { symbol: "❌", color: "var(--rust)" },
};

const TX = (hash: string) => `https://testnet.arcscan.app/tx/${hash}`;

const ROWS: Array<{ path: string; status: Status; detail: string; url?: string }> = [
  {
    path: "Escrow lifecycle · floored swap · multi-chain funding · refund bridge-back",
    status: "proven",
    detail: "proven on Arc",
  },
  {
    path: "Operator fee 25 bps split at capture, floor intact",
    status: "proven",
    detail: "0x7910f1…037420",
    url: TX("0x7910f15984c10fe929d3e642a84ca3be2c86d3727076fb3d57552899e0037420"),
  },
  {
    path: "Two-wallet mode — floor forwarded merchant → seller",
    status: "proven",
    detail: "0x11bf41…559bf4",
    url: TX("0x11bf41510b5aa7943dde09b436ff499064e4f9b8bea6c85f20a1057540559bf4"),
  },
  {
    path: "CPN EUR/SEPA end-to-end → COMPLETED",
    status: "proven",
    detail: "twice · 15 USDC → 12.92 EUR",
  },
  {
    path: "Seller-signed cash-out — seller's own wallet signs the CPN intent",
    status: "proven",
    detail: "15 USDC → €12.94 · 0x51e968…f049e7f",
    url: TX("0x51e9681d1d23fedeb239110a2c58309912a5c82d35a20c316b3102731f049e7f"),
  },
  {
    path: "Circle Mint redeem — USD → wire bank",
    status: "proven",
    detail: "complete · 10.00 USD · balance 350 → 340",
  },
  {
    path: "Circle Mint redeem — EUR → SEPA bank",
    status: "proven",
    detail: "complete ×2 · 10.00 EUR each · 273.49 → 253.49",
  },
  {
    path: "Seller EURC on Arc → Mint EUR balance, no bridge",
    status: "proven",
    detail: "1 EURC · 253.49 → 254.49 · 0x405164…2a8449e",
    url: TX("0x40516460af2571449291fa4448533793818dd287f9aeade449b1a13752a8449e"),
  },
  { path: "CPN BRL / MXN / USD", status: "partial", detail: "requirements + quote + prepare only" },
  {
    path: "CPN webhooks — real events, replayed through the reducer",
    status: "partial",
    detail: "5 signed events captured; our own endpoint not yet public",
  },
  { path: "Wallet-side Permit2 approve branch", status: "partial", detail: "written, skipped in that run" },
  { path: "Browser-wallet funding rails", status: "never", detail: "written, never executed on-chain" },
];

/** A ✅ row that names a tx should be checkable — otherwise it's still a claim. */
function Detail({ row }: { row: (typeof ROWS)[number] }) {
  const s = STATUS_STYLE[row.status];
  if (!row.url) return <>{row.detail}</>;
  return (
    <a
      href={row.url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-dotted underline-offset-4"
      style={{ color: s.color }}
    >
      {row.detail}
    </a>
  );
}

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
                <Detail row={r} />
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
                    <span aria-hidden>{s.symbol}</span> <Detail row={r} />
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
