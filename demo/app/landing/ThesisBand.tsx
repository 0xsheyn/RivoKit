export default function ThesisBand() {
  return (
    <section className="relative overflow-hidden bg-[var(--ink-raised)] py-12">
      <svg
        viewBox="0 0 1440 400"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full opacity-30"
        aria-hidden
      >
        <line x1="0" y1="200" x2="1440" y2="200" stroke="var(--verdigris)" strokeWidth="1" opacity="0.5" />
        {/* Kept clear of the vertical middle: the headline lives there, and a
            hash running through it reads as a rendering fault, not texture. */}
        {Array.from({ length: 26 }).map((_, i) => (
          <text
            key={i}
            x={(i * 1440) / 26 + 10}
            y={i % 2 === 0 ? 48 : 352}
            className="f-mono"
            fontSize="10"
            fill="var(--ash)"
          >
            {["stopLimit = €P", "25 bps", "COMPLETED", "0x7910f1…037420"][i % 4]}
          </text>
        ))}
      </svg>

      <div className="relative mx-auto max-w-5xl px-5 text-center">
        {/* Two deliberate lines. Each is its own block so that when one is too
            wide to fit it balances across two rows instead of dropping a
            single orphaned word — which is what "€P," was doing. */}
        <p
          className="f-display text-[var(--bone)]"
          style={{ fontSize: "clamp(30px, 6.4vw, 76px)", lineHeight: 1.08 }}
        >
          <span className="block text-balance">The recipient gets at least €P,</span>
          <span className="block text-balance">or the swap reverts.</span>
        </p>
        {/* Naming the path is not a hedge. Settling to a wallet the chain holds
            the floor; settling to a bank there is no swap to revert, so the
            guard is the corridor quote checked in the SDK before broadcast.
            Claiming "on-chain" for both would be claiming a floor the chain
            never sees. */}
        <p className="f-mono mt-6 text-[13px] text-[var(--ash)]">
          SETTLING TO A WALLET: ENFORCED ON-CHAIN BY stopLimit, NOT IN TYPESCRIPT · SETTLING TO A BANK: THE CPN QUOTE IS
          PINNED TO €P BEFORE BROADCAST, OR THE ORDER IS REFUSED
        </p>
      </div>
    </section>
  );
}
