import InView from "./InView";

/**
 * The thin rail that runs between sections (RIVO_LP.md §4/§7.2) — the same
 * payment path, drawn once as it enters the viewport. Verdigris because by
 * the time it's a section divider the money has already cleared that leg.
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
