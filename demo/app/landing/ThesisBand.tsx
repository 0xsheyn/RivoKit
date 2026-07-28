export default function ThesisBand() {
  return (
    <section className="relative overflow-hidden bg-[var(--ink-raised)] py-24">
      <svg
        viewBox="0 0 1440 400"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full opacity-40"
        aria-hidden
      >
        <line x1="0" y1="200" x2="1440" y2="200" stroke="var(--verdigris)" strokeWidth="1" opacity="0.5" />
        {Array.from({ length: 26 }).map((_, i) => (
          <text
            key={i}
            x={(i * 1440) / 26 + 10}
            y={i % 2 === 0 ? 150 : 260}
            className="f-mono"
            fontSize="10"
            fill="var(--ash)"
          >
            {["stopLimit €12.92", "25 bps", "COMPLETED", "0x7910f1…037420"][i % 4]}
          </text>
        ))}
      </svg>

      <div className="relative mx-auto max-w-4xl px-5 text-center">
        <p
          className="f-display text-[var(--bone)]"
          style={{ fontSize: "clamp(34px, 8vw, 88px)", lineHeight: 1.05 }}
        >
          The recipient gets at least €P,
          <br />
          or the swap reverts.
        </p>
        <p className="f-mono mt-6 text-[13px] text-[var(--ash)]">
          ENFORCED ON-CHAIN BY stopLimit — NOT IN TYPESCRIPT · THERE IS NO PATH WHERE THE RECIPIENT QUIETLY RECEIVES
          LESS
        </p>
      </div>
    </section>
  );
}
