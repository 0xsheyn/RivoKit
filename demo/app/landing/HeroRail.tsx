const MAIN_PATH = "M300,110 L620,110 L760,110 C880,110 920,54 1130,54";

/**
 * The hero's signature graphic (RIVO_LP.md §4/§6.1): three chains converge
 * into Arc, one line runs through escrow → a seam → swap, then branches into
 * four corridors. Only the SEPA branch is solid — the others are honestly
 * drawn as dashed hairlines because only EUR has settled end to end.
 *
 * `railDrawn` triggers the one-shot stroke draw-in. `coinPct` (0–1, or null
 * before the coin should appear) positions the traveling order along
 * `MAIN_PATH` via `offset-distance`, driven by the parent's rAF clock.
 * `settled` swaps the coin's label from `15.00 USDC` to `€12.92` and its
 * color from sodium to verdigris — the page's one bloom.
 */
export default function HeroRail({
  railDrawn,
  coinPct,
  settled,
}: {
  railDrawn: boolean;
  coinPct: number | null;
  settled: boolean;
}) {
  return (
    <div className="relative w-full">
      <svg
        viewBox="0 0 1200 220"
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        aria-hidden
      >
        {/* input chains converging on Arc */}
        <path d="M0,40 C130,40 170,110 300,110" fill="none" stroke="var(--ash)" strokeOpacity="0.35" strokeWidth="1.5" />
        <path d="M0,110 L300,110" fill="none" stroke="var(--ash)" strokeOpacity="0.35" strokeWidth="1.5" />
        <path d="M0,180 C130,180 170,110 300,110" fill="none" stroke="var(--ash)" strokeOpacity="0.35" strokeWidth="1.5" />

        <path
          d="M0,40 C130,40 170,110 300,110"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          className="rail-path"
          style={{ ["--rail-len" as string]: 420, transitionDelay: "0ms" }}
        />
        <path
          d="M0,110 L300,110"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          className="rail-path"
          style={{ ["--rail-len" as string]: 300, transitionDelay: "0ms" }}
        />
        <path
          d="M0,180 C130,180 170,110 300,110"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          className="rail-path"
          style={{ ["--rail-len" as string]: 420, transitionDelay: "0ms" }}
        />

        {/* Arc -> escrow -> seam -> swap */}
        <path
          d="M300,110 L620,110"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          className="rail-path"
          style={{ ["--rail-len" as string]: 320, transitionDelay: "250ms" }}
        />

        {/* seam: the deliberate join between settlement and off-ramp legs */}
        <g stroke="var(--bone)" strokeOpacity={railDrawn ? 0.55 : 0} strokeWidth="1.5" style={{ transition: "stroke-opacity 300ms ease-out 550ms" }}>
          <line x1="612" y1="96" x2="600" y2="124" />
          <line x1="628" y1="96" x2="616" y2="124" />
        </g>

        <path
          d="M620,110 L760,110"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          className="rail-path"
          style={{ ["--rail-len" as string]: 140, transitionDelay: "450ms" }}
        />

        {/* branch point */}
        <circle cx="760" cy="110" r="3" fill="var(--verdigris)" opacity={railDrawn ? 1 : 0} style={{ transition: "opacity 200ms ease-out 600ms" }} />

        {/* corridors — only SEPA proven solid, the rest honest dashed hairlines */}
        <path
          d="M760,110 C880,110 920,54 1130,54"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          className="rail-path"
          style={{ ["--rail-len" as string]: 420, transitionDelay: "650ms" }}
        />
        {[92, 132, 172].map((y) => (
          <path
            key={y}
            d={`M760,110 C880,110 920,${y} 1130,${y}`}
            fill="none"
            stroke="var(--ash)"
            strokeDasharray="3 5"
            strokeWidth="1.25"
            opacity={railDrawn ? 0.55 : 0}
            style={{ transition: "opacity 400ms ease-out 700ms" }}
          />
        ))}

        {/* stations — dots only; captions live in the copy above/below, not
            stamped under the wordmark where they'd be unreadable */}
        {[300, 460, 690].map((x) => (
          <circle key={x} cx={x} cy={110} r={3} fill="var(--verdigris)" opacity={railDrawn ? 1 : 0} style={{ transition: "opacity 300ms ease-out 500ms" }} />
        ))}

        {/* corridor end labels — SEPA has none: the coin's own settled value
            lands there instead, so the two never have to fight for the spot */}
        <text x="1140" y="96" className="f-mono" fontSize="11" fill="var(--ash)">
          PIX ·
        </text>
        <text x="1140" y="136" className="f-mono" fontSize="11" fill="var(--ash)">
          SPEI ·
        </text>
        <text x="1140" y="176" className="f-mono" fontSize="11" fill="var(--ash)">
          WIRE ·
        </text>

        {/* input labels */}
        <text x="6" y="34" className="f-mono" fontSize="11" fill="var(--ash)">ETH</text>
        <text x="6" y="104" className="f-mono" fontSize="11" fill="var(--ash)">BASE</text>
        <text x="6" y="174" className="f-mono" fontSize="11" fill="var(--ash)">OP</text>

        {/* the traveling order */}
        {coinPct !== null && (
          <g style={{ offsetPath: `path("${MAIN_PATH}")`, offsetDistance: `${coinPct * 100}%`, offsetRotate: "0deg" }}>
            <circle r="4.5" fill={settled ? "var(--verdigris)" : "var(--sodium)"} style={{ transition: "fill 300ms ease-out" }} />
            <foreignObject x="-70" y={settled ? 12 : -32} width="140" height="20" style={{ overflow: "visible" }}>
              <div
                className={`f-mono text-center text-[11px] ${settled ? "text-[var(--verdigris)]" : "text-[var(--sodium)]"}`}
                style={{ transition: "color 300ms ease-out", textShadow: settled ? "0 0 18px color-mix(in oklab, var(--verdigris) 70%, transparent)" : "none" }}
              >
                {settled ? "€12.92" : "15.00 USDC"}
              </div>
            </foreignObject>
          </g>
        )}
      </svg>
    </div>
  );
}
