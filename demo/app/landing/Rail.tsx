import InView from "./InView";

/**
 * The thin rail that runs between sections (RIVO_LP.md §4/§7.2) — the same
 * payment path, drawn once as it enters the viewport. Verdigris because by
 * the time it's a section divider the money has already cleared that leg.
 *
 * **Where it goes.** `RailDivider` stands BETWEEN two plain sections, in
 * `page.tsx`. Two sections in a row that are both plain get one; a section
 * followed by a full-bleed band (ThesisBand, Ticker, CtaInstall) does not,
 * because the band already draws its own edge and two dividers touching read as
 * a mistake.
 *
 * It moved out of the sections deliberately. As a last child under `mt-12` it
 * *added* ~60px to every gap it appeared in, which is how section-to-section
 * spacing reached 188px against 56–64px between subsections — the same page
 * separating its parts four times harder than its own chapters. Standing in the
 * gap instead, it costs only its own 12px: 32 + 12 + 32 = 76px.
 */
export default function Rail({ className = "" }: { className?: string }) {
  return (
    <InView className={`rail-drawn-wrap ${className}`} activeClassName="rail-drawn">
      <svg viewBox="0 0 1000 12" preserveAspectRatio="none" className="h-3 w-full overflow-visible" aria-hidden>
        <line
          x1="0"
          y1="6"
          x2="1000"
          y2="6"
          stroke="var(--ash)"
          strokeOpacity="0.25"
          strokeWidth="1"
        />
        <line
          x1="0"
          y1="6"
          x2="1000"
          y2="6"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          className="rail-path"
          style={{ ["--rail-len" as string]: 1000 }}
        />
        <circle cx="500" cy="6" r="3" fill="var(--sodium)" />
      </svg>
    </InView>
  );
}

/**
 * The rail as a between-sections divider, carrying the same container the
 * sections use so it lines up with their content rather than running edge to
 * edge. No margin of its own: the sections' padding is the gap.
 */
export function RailDivider() {
  return (
    <div className="mx-auto w-full max-w-[1440px] px-5 md:px-16">
      <Rail />
    </div>
  );
}
