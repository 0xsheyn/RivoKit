/**
 * The four tokens the text border repeats. Kept short on purpose — at this
 * opacity they are texture that happens to be readable, not a second thing to
 * read.
 */
const TOKENS = ["stopLimit = €P", "25 bps", "COMPLETED", "0x7910f1…037420"];

/**
 * Enough cycles to overrun the widest viewport at this size, so the row always
 * reaches both edges. The section clips the tail; a row that stopped short
 * would read as a list that ran out, not as a border.
 */
const TOKEN_CYCLES = 10;

/**
 * A border made of text.
 *
 * Not flanked by rules any more — the hairlines moved to the words they belong
 * to, below. What is left here is the thing itself: one unbroken full-width run
 * of mono tokens, top and bottom, edge to edge.
 */
function TokenRow({ className }: { className: string }) {
  return (
    <div className={`pointer-events-none absolute inset-x-0 overflow-hidden ${className}`} aria-hidden>
      <div className="f-mono flex w-max gap-8 whitespace-nowrap text-[10px] text-[color:var(--ash)]/40">
        {Array.from({ length: TOKEN_CYCLES }).flatMap((_, cycle) =>
          TOKENS.map((t) => <span key={`${cycle}-${t}`}>{t}</span>),
        )}
      </div>
    </div>
  );
}

/**
 * A line of type with a hairline running in from each edge and stopping at the
 * words.
 *
 * **The rules are absolutely positioned, and that is the whole design.** The
 * first version of this laid the line out as `flex` — rule, text, rule — which
 * looks equivalent and is not: two `flex-1` rules plus their gaps claimed about
 * 70px of the row, the headline no longer fitted the measure it used to fit,
 * and it broke from two lines to three. A rule is decoration on a sentence; it
 * must not get a vote on where that sentence wraps.
 *
 * So the text sits in an `inline-block` that shrinks to its own natural width
 * exactly as a bare centred line would, `text-balance` and all, and the rules
 * hang off `right-full` / `left-full` outside it. They steal zero width, so the
 * line count is whatever it would have been with no rules at all.
 *
 * `w-[50vw]` is not a measurement, it is an overrun: each rule is guaranteed to
 * be longer than the space it has, and the section's `overflow-hidden` cuts it
 * at the edge. That is what makes them reach the ends on every viewport instead
 * of stopping at some container's padding.
 *
 * Applied to the FIRST line of each block only; the continuation sits plain
 * underneath, which is what keeps this a rule and not a box.
 */
function RuledLine({ children }: { children: React.ReactNode }) {
  return (
    <span className="block">
      <span className="relative inline-block text-balance">
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute right-full top-1/2 mr-4 h-px w-[50vw] -translate-y-1/2 bg-[color:var(--verdigris)]/25 sm:mr-6"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute left-full top-1/2 ml-4 h-px w-[50vw] -translate-y-1/2 bg-[color:var(--verdigris)]/25 sm:ml-6"
        />
      </span>
    </span>
  );
}

export default function ThesisBand() {
  return (
    <section className="relative overflow-hidden bg-[var(--ink-raised)] py-16 md:py-20">
      {/* This band used to be one SVG with `preserveAspectRatio="none"` — a
          1440×400 viewBox stretched to whatever box it actually had, which
          scaled its text non-uniformly (squeezed narrow, flattened wide) and is
          why tokens nominally at 10px never looked like 10px or like each
          other. SVG text cannot survive a non-uniform transform, so none of
          this is SVG any more. */}
      <TokenRow className="top-5" />
      <TokenRow className="bottom-5" />

      <div className="relative mx-auto max-w-5xl px-5 text-center md:px-16">
        {/* Two deliberate lines. Each is its own block so that when one is too
            wide to fit it balances across two rows instead of dropping a
            single orphaned word — which is what "€P," was doing. */}
        {/* Two lines, and it stays two: the rules beside the first one are
            absolutely positioned precisely so this measure is the same measure
            it was before they existed. */}
        <p className="f-display text-[var(--bone)]" style={{ fontSize: "clamp(30px, 6.4vw, 76px)", lineHeight: 1.08 }}>
          <RuledLine>The recipient gets at least €P,</RuledLine>
          <span className="block text-balance">or the swap reverts.</span>
        </p>

        {/* Naming the path is not a hedge. Settling to a wallet the chain holds
            the floor; settling to a bank there is no swap to revert, so the
            guard is the corridor quote checked in the SDK before broadcast.
            Claiming "on-chain" for both would be claiming a floor the chain
            never sees.

            The two clauses used to be one paragraph joined by a "·" and left to
            wrap wherever the width happened to break it. They are two blocks
            now, which is what lets the rule sit on the first one — and it reads
            better besides: the whole point is that these are two different
            guards, so a line break between them is doing work. */}
        <p className="f-mono mt-8 space-y-1.5 text-[12px] leading-relaxed text-[var(--ash)] sm:text-[13px]">
          <RuledLine>SETTLING TO A WALLET: ENFORCED ON-CHAIN BY stopLimit, NOT IN TYPESCRIPT</RuledLine>
          <span className="block">
            SETTLING TO A BANK: THE CPN QUOTE IS PINNED TO €P BEFORE BROADCAST, OR THE ORDER IS REFUSED
          </span>
        </p>
      </div>
    </section>
  );
}
