import { PACKAGES } from "./stack";

/**
 * The stack, scrolling — every runtime dependency by name.
 *
 * It used to carry seven proof figures (the €10.00 bank order, both corridor
 * results, the 25 bps fee, the rebate, a capture hash). Those moved out on the
 * owner's instruction and are not lost: every one of them is a row in the §05
 * ledger, where it sits next to what it does not establish. A hash needs that
 * qualifier beside it; a package name does not, which is why the strip reads
 * more honestly as a stack than as evidence.
 *
 * Derived from `stack.ts`, the same list the docs §02 table renders. Retyping
 * it here would mean two places to bump on every upgrade, and a landing page
 * advertising a version the project no longer installs is the fastest way to
 * look unmaintained.
 */
function Segment() {
  return (
    <span className="flex shrink-0 items-center">
      {PACKAGES.map((item) => (
        <span key={item} className="flex items-center">
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
      {/* Rendered twice so the CSS marquee's translateX(-50%) lands exactly on
          a seam — one copy would snap back visibly at the loop point. */}
      <div
        className="ticker-track f-mono flex w-max whitespace-nowrap text-[11px] text-[var(--ash)]"
        style={{ height: "34px", alignItems: "center" }}
      >
        <Segment />
        <Segment />
      </div>
    </div>
  );
}
