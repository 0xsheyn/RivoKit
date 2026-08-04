type Status = "proven" | "partial" | "never";

const STATUS_STYLE: Record<Status, { symbol: string; color: string; label: string }> = {
  proven: { symbol: "✅", color: "var(--verdigris)", label: "Proven" },
  partial: { symbol: "⚠️", color: "var(--sodium)", label: "Partial" },
  never: { symbol: "❌", color: "var(--rust)", label: "Not proven" },
};

const TX = (hash: string) => `https://testnet.arcscan.app/tx/${hash}`;

/**
 * `short` is what the grid shows; `path` is the full claim and only appears in
 * the tooltip. The grid trades detail for scanability, so the claim itself must
 * survive somewhere it can still be read in full — shortening it in place would
 * quietly widen what each ✅ is asserting.
 */
const ROWS: Array<{ short: string; path: string; status: Status; detail: string; url?: string }> = [
  {
    short: "Escrow lifecycle",
    path: "Escrow lifecycle · floored swap · multi-chain funding · refund bridge-back",
    status: "proven",
    detail: "proven on Arc",
  },
  // The headline claim, and it was missing from this table entirely while the
  // ❌ row below still said the browser rails had never run. Both are fixed
  // against PROOFS.md rather than from memory.
  {
    short: "Escrow to bank, one call",
    path: "release() reaching a bank in ONE call — capture → CPN quote pinned to €P → broadcast",
    status: "proven",
    detail: "11.751140 USDC → €10.00 exactly · capture 0x631405…9966698",
    url: TX("0x63140582f99e748e2af4c4f1f281fc086f5ee953f861668eb161adf7a9966698"),
  },
  {
    short: "Rebate, checked on-chain",
    path: "The bank path's rebate, checked against the chain rather than an event",
    status: "proven",
    detail: "buyer +0.474498 USDC · 0x50ef69…677c7c9e",
    url: TX("0x50ef691a0e2123966b81451f09dee0cb0a4a9e1f9f30699419bd90f7677c7c9e"),
  },
  {
    short: "Both demos reach a bank",
    path: "Both demos reaching a bank through their own code, not a script",
    status: "proven",
    detail: "/sdk UI · marketplace server actions",
  },
  {
    short: "Operator fee 25 bps",
    path: "Operator fee 25 bps split at capture, floor intact",
    status: "proven",
    detail: "0x7910f1…037420",
    url: TX("0x7910f15984c10fe929d3e642a84ca3be2c86d3727076fb3d57552899e0037420"),
  },
  {
    short: "Two-wallet mode",
    path: "Two-wallet mode — floor forwarded merchant → seller",
    status: "proven",
    detail: "0x11bf41…559bf4",
    url: TX("0x11bf41510b5aa7943dde09b436ff499064e4f9b8bea6c85f20a1057540559bf4"),
  },
  {
    short: "CPN EUR/SEPA",
    path: "CPN EUR/SEPA → COMPLETED",
    status: "proven",
    detail: "twice · 15 USDC → 12.92 EUR",
  },
  // No link: PROOFS.md records this Arc tx only in abbreviated form, and a
  // plausible-looking full hash is exactly the thing this table exists to not do.
  {
    short: "CPN USD/WIRE",
    path: "CPN USD/WIRE → COMPLETED, wallet-signed",
    status: "proven",
    detail: "62 USDC → 36.96 USD · flat 25 USDC fee · block 54765268",
  },
  {
    short: "Seller-signed cash-out",
    path: "Seller-signed cash-out — seller's own wallet signs the CPN intent",
    status: "proven",
    detail: "15 USDC → €12.94 · 0x51e968…f049e7f",
    url: TX("0x51e9681d1d23fedeb239110a2c58309912a5c82d35a20c316b3102731f049e7f"),
  },
  {
    short: "Mint redeem · USD wire",
    path: "Circle Mint redeem — USD → wire bank",
    status: "proven",
    detail: "complete · 10.00 USD · balance 350 → 340",
  },
  {
    short: "Mint redeem · EUR SEPA",
    path: "Circle Mint redeem — EUR → SEPA bank",
    status: "proven",
    detail: "complete ×2 · 10.00 EUR each · 273.49 → 253.49",
  },
  {
    short: "EURC on Arc → Mint EUR",
    path: "Seller EURC on Arc → Mint EUR balance, no bridge",
    status: "proven",
    detail: "1 EURC · 253.49 → 254.49 · 0x405164…2a8449e",
    url: TX("0x40516460af2571449291fa4448533793818dd287f9aeade449b1a13752a8449e"),
  },
  {
    short: "Webhook signature verified",
    path: "CPN webhook → signature verified → cash-out row advanced",
    status: "proven",
    detail: "live signatures · row reached COMPLETED",
  },
  // Arrival was the open question and it closed: Circle validated the URL with
  // HEAD and POSTed five signed events into our own route. What is still open
  // is whether that URL survives the process that created it — a different
  // claim, and the only one this row may make.
  {
    short: "Webhook over our own route",
    path: "That webhook arriving over HTTP at our own route, and only it moving the row",
    status: "proven",
    detail: "proven by REMOVING the competing writer, not out-racing it",
  },
  {
    short: "Durable webhook host",
    path: "A webhook endpoint that outlives the process which created it",
    status: "partial",
    detail: "the proof rode a quick tunnel · needs a durable host",
  },
  {
    short: "Permit2 approve from zero",
    path: "Wallet-side Permit2 approve — from a zero allowance",
    status: "proven",
    detail: "0 → 15 → 0 USDC · 0xdeebf4…cf11177a",
    url: TX("0xdeebf45ad5e1747693e33e2de0dabca14ccef1323d27d29aaaf598f7cf11177a"),
  },
  {
    short: "Browser wallet rails",
    path: "Browser-wallet funding rails, executed on-chain",
    status: "proven",
    detail: "Gateway spend 0xca092f…4d774517 · CCTP mint 0x35da17…fe945639",
    url: TX("0xca092f363b2dab2d891d7e29e274422f2362227c7af2283d6d6a33c49d774517"),
  },
  // What is left of that row once the rails themselves are proven: a narrower
  // claim, and still a genuine ❌ — no server key may stand in for a click.
  {
    short: "Human clicking wallet prompts",
    path: "A human clicking the wallet's switch-chain and add-chain prompts",
    status: "never",
    detail: "driven by an EIP-1193 provider · every answer has a branch and a test",
  },
  {
    short: "Bank button in marketplace",
    path: "A bank-payout button in the marketplace UI",
    status: "never",
    detail: "the /sdk page has the toggle",
  },
  {
    short: "Euros seen arriving",
    path: "Anyone watching euros arrive in a bank account",
    status: "never",
    detail: "sandbox settles nothing · every destination IBAN is fabricated",
  },
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
      // Dotted at rest, solid on hover: the row is claiming a hash you can go
      // and open, and the underline firming up is that offer being taken up.
      className="underline decoration-dotted underline-offset-4 transition-all hover:decoration-solid"
      style={{ color: s.color }}
    >
      {row.detail}
    </a>
  );
}

function Card({ row }: { row: (typeof ROWS)[number] }) {
  const s = STATUS_STYLE[row.status];
  return (
    // tabIndex makes the card reachable by keyboard, and :focus-within matches
    // the element itself — so Tab opens the same panel hover does, and the tx
    // link inside stays tabbable.
    <div
      tabIndex={0}
      className="group relative rounded-sm border border-[color:var(--ash)]/15 p-3 transition-colors hover:border-[color:var(--ash)]/35 focus-within:border-[color:var(--ash)]/35 md:p-4"
    >
      <div className="flex items-start gap-2">
        <span className="text-[17px] leading-none md:text-[19px]" aria-hidden>
          {s.symbol}
        </span>
        <span className="sr-only">{s.label}: </span>
        <p className="text-[12px] leading-snug text-[var(--bone)]/85 md:text-[13px]">{row.short}</p>
      </div>

      {/* Below md there is no cursor to hover with, so the detail stays on the
          card rather than hiding behind a gesture the device cannot make. */}
      <p className="f-mono mt-2 break-words text-[11px] leading-relaxed md:hidden" style={{ color: s.color }}>
        <Detail row={row} />
      </p>

      <div
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-72 -translate-x-1/2 rounded-sm border border-[color:var(--ash)]/30 bg-[var(--ink-raised)] p-3 opacity-0 shadow-lg transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 md:block"
      >
        <p className="mb-2 text-[12px] leading-snug text-[var(--bone)]/85">{row.path}</p>
        <p className="f-mono break-words text-[11px] leading-relaxed" style={{ color: s.color }}>
          <Detail row={row} />
        </p>
      </div>
    </div>
  );
}

export default function Ledger() {
  return (
    <div>
      <p className="eyebrow mb-4">
        THIS TABLE FOLLOWS PROOFS.MD AND LIMITATIONS.MD — WE DON&apos;T HIDE THE ❌ COLUMN.
      </p>

      {/* The ceiling on every ✅ that touches fiat. PROOFS.md opens with it and
          LIMITATIONS.md caps everything with it; a page titled "Proof, not
          claims" that omitted it was the most expensive thing wrong here. */}
      <p className="mb-6 max-w-3xl border-l-2 border-[color:var(--sodium)] pl-4 text-[13px] leading-relaxed text-[var(--bone)]/75">
        <span className="text-[var(--bone)]">Read every ✅ on the fiat side with this ceiling.</span>{" "}
        <span className="f-mono text-[var(--sodium)]">COMPLETED</span> means CPN reported the fiat leg finished — not
        that anyone watched euros arrive. The sandbox is a simulator, every payout destination here is a fabricated
        IBAN, and the one destination whose balance could actually be read was never credited. The on-chain legs are a
        different grade of evidence entirely: hashes anyone can open, forever.
      </p>

      <p className="eyebrow mb-3 hidden md:block">HOVER OR TAB A CARD FOR THE CLAIM IN FULL AND ITS HASH</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {ROWS.map((r) => (
          <Card key={r.path} row={r} />
        ))}
      </div>
    </div>
  );
}
