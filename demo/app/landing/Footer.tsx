import { NAV } from "./Topbar";

export default function Footer() {
  return (
    <footer className="relative overflow-hidden px-5 pt-12 md:px-16">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 border-b border-[color:var(--ash)]/20 pb-8 text-[13px] text-[var(--bone)]/70">
        {/* The topbar's list, imported rather than retyped — see Topbar.tsx. The
            explorer link is the one addition: it leaves the page entirely, which
            is why the topbar does not carry it.

            Serif italic, matching the bar at the other end of the page: the
            same five links should not change face depending on which end of the
            scroll you read them at. They were mono, which reads as data — and a
            nav link is not data. The mono in this footer is now only on the
            line that IS data, the chain id below. */}
        <div className="f-display flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px]">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="link-step">
              {item.label}
            </a>
          ))}
          <a
            href="https://testnet.arcscan.app/address/0x6bfd1895d519d2ec936038824b8c7ab4ff700253"
            target="_blank"
            rel="noopener noreferrer"
            className="link-step"
          >
            Contracts (arcscan)
          </a>
        </div>
        <p className="eyebrow">Testnet-stage sample software — not a licensed financial product.</p>
      </div>

      <div className="mx-auto mt-6 max-w-[1440px]">
        {/* "ROUTE CLOSED · CPN COMPLETED" read as money landing. The route that
            closed is the on-chain one, which is the half anyone can verify. */}
        <p className="f-mono text-[11px] text-[var(--verdigris)]">
          ARC TESTNET · CHAIN 5042002 ·{" "}
          <span className="text-[var(--ash)]">CPN REPORTED COMPLETED — NOT A BANK STATEMENT</span>
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
