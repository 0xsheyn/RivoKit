export default function Footer() {
  return (
    <footer className="relative overflow-hidden px-5 pt-16 md:px-16">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 border-b border-[color:var(--ash)]/20 pb-8 text-[13px] text-[var(--bone)]/70">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 f-mono">
          <a href="#top" className="hover-step">
            Overview
          </a>
          <a href="/app" className="hover-step">
            How it works
          </a>
          <a href="https://github.com/0xsheyn/RivoKit#api" target="_blank" rel="noopener noreferrer" className="hover-step">
            API
          </a>
          <a
            href="https://testnet.arcscan.app/address/0x6bfd1895d519d2ec936038824b8c7ab4ff700253"
            target="_blank"
            rel="noopener noreferrer"
            className="hover-step"
          >
            Contracts (arcscan)
          </a>
          <a href="https://github.com/0xsheyn/RivoKit/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="hover-step">
            Apache-2.0
          </a>
        </div>
        <p className="eyebrow">Testnet-stage sample software — not a licensed financial product.</p>
      </div>

      <div className="mx-auto mt-6 max-w-[1440px]">
        <p className="f-mono text-[11px] text-[var(--verdigris)]">
          ROUTE CLOSED · 15.00 USDC → €12.92 · ARC TESTNET · CHAIN 5042002 · CPN COMPLETED
        </p>
      </div>

      <p
        aria-hidden
        className="f-display pointer-events-none mt-6 select-none text-center leading-none text-[var(--bone)]/10"
        style={{ fontSize: "clamp(96px, 24vw, 320px)", transform: "translateY(18%)" }}
      >
        rivokit
      </p>
    </footer>
  );
}
