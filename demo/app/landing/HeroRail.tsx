import ethIcon from "../../assets/USDC Token_ETH.png";
import baseIcon from "../../assets/USDC Token_BASE.png";
import avaIcon from "../../assets/USDC Token_AVA.png";
import arcIcon from "../../assets/USDC Token_ARC.png";

/**
 * The hero's signature graphic: one order walking the whole route, from three
 * chains to a bank account — every station it actually passes through.
 *
 * ── Where this drawing comes from ────────────────────────────────────────────
 *
 * `demo/assets/flow_rivo_transparent.png`, drawn by hand before this component
 * existed. Earlier versions here kept only its endpoints — three sources, an
 * escrow, two labels — which made the middle of the product disappear: no
 * bridge, no quote, no swap, no way back from EURC. A route with nothing
 * between its ends cannot show that anything happens along it.
 *
 * Every node below is a real step with a real name in the codebase:
 *   CCTP / Gateway   `funding/bridge.ts`, `funding/unified-balance.ts`
 *   ERC-3009         `escrow/erc3009.ts` — payer signs, operator relays
 *   escrow           `escrow/operations.ts` — authorize, capture, void, refund
 *   CPN quote        `payout/cpn-rail.ts`, pinned to the guaranteed price
 *   floored swap     `settlement-fx/swap.ts`, carrying stopLimit
 *   Circle Mint      the only exit EURC has, and deliberately not wired to
 *                    release() — hence the dashed link
 *
 * ── Two earlier bugs, kept written down ──────────────────────────────────────
 *
 * The first version never animated: its paths carried `rail-path`, which parks
 * a stroke at full `stroke-dashoffset` until an ANCESTOR carries `rail-drawn`,
 * and nothing in the hero ever applied that class. Everything verdigris was
 * invisible and the coin ran along a path nobody could see.
 *
 * The asset filenames contain a space, which Next keeps in the emitted URL. A
 * raw space in an `href` does not resolve — verified against the dev server,
 * where the unencoded path fails outright and the percent-encoded one returns
 * 200. Hence `iconSrc`.
 *
 * ── The one thing worth remembering ──────────────────────────────────────────
 *
 * The order STOPS at the escrow. Not a slow section — a full stop, while the
 * node glows, before it moves on. Every payment graphic ever drawn streams
 * money left to right; this product's whole claim is that the money is *held*,
 * under conditions, until a host releases it. A pause is the only honest way to
 * draw that, and it costs one piecewise function.
 */

/** Percent-encoded because the source filenames contain spaces. */
const iconSrc = (icon: { src: string }) => encodeURI(icon.src);

export type Route = "bank" | "wallet";

/**
 * The two routes. Identical until the fork, mirrored after it — so the stop
 * distances below hold for both, and only the branch's `y` changes.
 */
const PATHS: Record<Route, string> = {
  bank: "M86,140 L850,140 C880,140 880,60 900,60 L1190,60",
  wallet: "M86,140 L850,140 C880,140 880,220 900,220 L1190,220",
};

/**
 * The stations the order stops at, as fractions of the route.
 *
 * Measured off the path by integrating it, not guessed: it runs 1153.7 units
 * from x=86 (764 straight + 99.7 of fork curve + 290 straight), so the Arc
 * arrival at x=300 is 0.185, the escrow's centre at x=640 is 0.480, and the
 * branch node's centre at x=980 is 0.818.
 *
 * It stopped only at the escrow before, which quietly demoted the other two:
 * a route whose order sails past a station is a route where nothing happens
 * there. Bridging, holding and quoting are three separate things that take
 * three separate amounts of real time, and each is drawn as a stop.
 *
 * The last stop's position is load-bearing in a way the others are not. It sat
 * at 0.865 while the branch node ended at x=1130 and the destination box began
 * at x=1190 — sixty units, four percent of the drawing. After dwelling at the
 * quote the order crossed that in a blink and halted on the box's left edge,
 * which reads exactly like stopping at the quote and never arriving. The branch
 * node moved left to buy the final leg 210 units of travel; the fix is distance,
 * not duration.
 */
const STOPS = [0.185, 0.48, 0.818];
/** Share of the whole run each stop consumes, standing still. */
const DWELL = 0.11;

type Position = { d: number; stop: number | null };

/**
 * Linear clock → where the order is, and which station is holding it.
 *
 * Travel time is proportional to distance, so the long empty spine takes longer
 * to cross than the short hop into the branch node — the pacing reads as speed
 * rather than as an arbitrary schedule.
 */
function positionAt(t: number): Position {
  const points = [0, ...STOPS, 1];
  const travel = 1 - DWELL * STOPS.length;
  let clock = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i] ?? 0;
    const to = points[i + 1] ?? 1;
    const legTime = (to - from) * travel;
    if (t < clock + legTime) {
      return { d: from + (to - from) * (legTime === 0 ? 1 : (t - clock) / legTime), stop: null };
    }
    clock += legTime;
    if (i < STOPS.length) {
      if (t < clock + DWELL) return { d: to, stop: i };
      clock += DWELL;
    }
  }
  return { d: 1, stop: null };
}

/** What the order is worth, and what just happened to it. */
function readoutFor(pos: Position, route: Route, settled: boolean) {
  const held = { color: "var(--bone)" };
  if (pos.stop === 0) return { text: "ON ARC", ...held };
  if (pos.stop === 1) return { text: "HELD", ...held };
  if (pos.stop === 2) return { text: route === "bank" ? "QUOTED €10.00" : "SWAPPED → EURC", ...held };
  if (settled || pos.d >= 1) {
    return { text: route === "bank" ? "€10.00" : "€10.00 EURC", color: "var(--verdigris)" };
  }
  // Between the escrow and the branch node the capture has happened, so it is
  // no longer the payer's money and not yet the recipient's currency.
  const captured = pos.d > (STOPS[1] ?? 0);
  return { text: captured ? "CAPTURED" : "11.75 USDC", color: "var(--sodium)" };
}

/**
 * Inbound lanes. Each gets its chain's own USDC token mark, because "the payer
 * holds USDC where they hold it" is the claim, and three identical dots do not
 * say that — three USDC marks wearing different chain badges do.
 */
const LANES = [
  { label: "ETH", icon: ethIcon, y: 95, d: "M86,95 C180,95 220,140 284,140", len: 220 },
  { label: "BASE", icon: baseIcon, y: 140, d: "M86,140 L284,140", len: 200 },
  { label: "AVAX", icon: avaIcon, y: 185, d: "M86,185 C180,185 220,140 284,140", len: 220 },
];

/** A station on the route. Boxes, because a station is a place, not a point. */
function Node({
  x,
  y,
  w,
  title,
  lines,
  accent = "var(--ash)",
  glow = false,
}: {
  x: number;
  y: number;
  w: number;
  title: string;
  lines?: string[];
  accent?: string;
  glow?: boolean;
}) {
  const h = 70;
  const rows = lines ?? [];
  // Title rides higher as sub-lines are added, so the block stays optically
  // centred rather than the title alone being centred.
  const titleY = y + h / 2 + 4 - rows.length * 7;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="7"
        fill="var(--ink-raised)"
        stroke={accent}
        strokeOpacity={glow ? 0.95 : 0.45}
        strokeWidth="1.5"
        style={{ transition: "stroke-opacity 260ms ease-out" }}
      />
      <text x={x + w / 2} y={titleY} textAnchor="middle" className="f-mono" fontSize="12" fill="var(--bone)">
        {title}
      </text>
      {rows.map((line, i) => (
        <text
          key={line}
          x={x + w / 2}
          y={titleY + 16 + i * 13}
          textAnchor="middle"
          className="f-mono"
          fontSize="10"
          fill="var(--ash)"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

export default function HeroRail({
  railDrawn,
  coinPct,
  settled,
  route,
}: {
  railDrawn: boolean;
  coinPct: number | null;
  settled: boolean;
  route: Route;
}) {
  const pos: Position = coinPct === null ? { d: 0, stop: null } : positionAt(coinPct);
  const readout = readoutFor(pos, route, settled);
  const bank = route === "bank";

  return (
    // The class the first version was missing. Everything with `rail-path` below
    // stays invisible until it lands here.
    <div className={railDrawn ? "rail-drawn" : undefined}>
      <svg
        viewBox="0 0 1440 280"
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full overflow-visible"
        role="img"
      >
        <title>
          USDC arrives from Ethereum, Base or Avalanche, crosses to Arc over CCTP or a Gateway unified balance, is
          authorized gaslessly with ERC-3009 and held in the RivoKit escrow. Releasing it either quotes the Circle
          Payments Network against the guaranteed price and pays a local bank account, or runs a floored swap to EURC on
          Arc — which can be redeemed to a bank separately through Circle Mint.
        </title>

        <defs>
          <radialGradient id="rivo-hold-glow">
            <stop offset="0%" stopColor="var(--bone)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--bone)" stopOpacity="0" />
          </radialGradient>
          <marker id="rivo-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,1 L7,4 L0,7 Z" fill="var(--verdigris)" />
          </marker>
          <marker id="rivo-arrow-ash" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,1 L7,4 L0,7 Z" fill="var(--ash)" />
          </marker>
        </defs>

        {/* ── Sources ──────────────────────────────────────────────────────── */}
        {/* Every route is drawn twice: an ash hairline that is always there, and
            a verdigris stroke drawn over it once the section is live. The
            hairline is what stops the graphic reading as broken before the
            clock starts, or if the animation never runs at all. */}
        {LANES.map((l) => (
          <path key={l.label} d={l.d} fill="none" stroke="var(--ash)" strokeOpacity="0.28" strokeWidth="1.5" />
        ))}
        {LANES.map((l, i) => (
          <path
            key={`${l.label}-live`}
            d={l.d}
            fill="none"
            stroke="var(--verdigris)"
            strokeWidth="1.5"
            className="rail-path"
            style={{ ["--rail-len" as string]: l.len, transitionDelay: `${i * 80}ms` }}
          />
        ))}
        {LANES.map((l) => (
          <g key={`${l.label}-mark`}>
            <image href={iconSrc(l.icon)} x="0" y={l.y - 14} width="28" height="28" />
            <text x="36" y={l.y + 4} className="f-mono" fontSize="11" fill="var(--ash)">
              {l.label}
            </text>
          </g>
        ))}

        {/* ── The bridge ───────────────────────────────────────────────────── */}
        {/* USDC does not appear on Arc: it is burned and minted across, or spent
            out of a unified balance. The step with the latency and the failure
            modes, named over the fan where it happens. */}
        <text x="90" y="70" className="f-mono" fontSize="11" fill="var(--sodium)">
          CCTP BRIDGE · GATEWAY UNIFIED BALANCE
        </text>

        {/* Arrival, wearing Arc's own USDC mark — the bridge's output drawn as a
            thing rather than described as one. It is a station like the others,
            so it lights when the order is standing on it; the ring is what a
            box would have been if a 32px icon had room for one. */}
        <circle
          cx="300"
          cy="140"
          r="60"
          fill="url(#rivo-hold-glow)"
          opacity={pos.stop === 0 ? 1 : 0}
          style={{ transition: "opacity 300ms ease-out" }}
        />
        <circle
          cx="300"
          cy="140"
          r="22"
          fill="none"
          stroke="var(--bone)"
          strokeWidth="1.5"
          opacity={pos.stop === 0 ? 0.9 : 0}
          style={{ transition: "opacity 260ms ease-out" }}
        />
        <image href={iconSrc(arcIcon)} x="284" y="124" width="32" height="32" />
        <text x="300" y="172" textAnchor="middle" className="f-mono" fontSize="11" fill="var(--ash)">
          ON ARC
        </text>

        {/* ── Arc: authorize, then hold ────────────────────────────────────── */}
        <path d="M316,140 L520,140" fill="none" stroke="var(--ash)" strokeOpacity="0.28" strokeWidth="1.5" />
        <path
          d="M316,140 L520,140"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          className="rail-path"
          style={{ ["--rail-len" as string]: 204, transitionDelay: "240ms" }}
        />
        <text x="330" y="124" className="f-mono" fontSize="11" fill="var(--ash)">
          ERC-3009 · GASLESS
        </text>

        <circle
          cx="640"
          cy="140"
          r="86"
          fill="url(#rivo-hold-glow)"
          opacity={pos.stop === 1 ? 1 : 0}
          style={{ transition: "opacity 300ms ease-out" }}
        />
        <Node
          x={520}
          y={105}
          w={240}
          title="RIVOKIT ESCROW"
          lines={["authorize → hold →", "capture / void / refund"]}
          accent="var(--bone)"
          glow={pos.stop === 1}
        />

        <path d="M760,140 L850,140" fill="none" stroke="var(--ash)" strokeOpacity="0.28" strokeWidth="1.5" />
        <path
          d="M760,140 L850,140"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          className="rail-path"
          style={{ ["--rail-len" as string]: 90, transitionDelay: "420ms" }}
        />

        {/* ── The fork ─────────────────────────────────────────────────────── */}
        {/* Both endings are real, so both are drawn solid; the order takes the
            bank branch because that is the claim the page leads on. */}
        <circle
          cx="850"
          cy="140"
          r="3.5"
          fill="var(--verdigris)"
          opacity={railDrawn ? 1 : 0}
          style={{ transition: "opacity 200ms ease-out 500ms" }}
        />
        {[
          { d: "M850,140 C880,140 880,60 900,60", delay: 500 },
          { d: "M850,140 C880,140 880,220 900,220", delay: 560 },
        ].map((b) => (
          <g key={b.d}>
            <path d={b.d} fill="none" stroke="var(--ash)" strokeOpacity="0.28" strokeWidth="1.5" />
            <path
              d={b.d}
              fill="none"
              stroke="var(--verdigris)"
              strokeWidth="1.5"
              className="rail-path"
              style={{ ["--rail-len" as string]: 105, transitionDelay: `${b.delay}ms` }}
            />
          </g>
        ))}

        <text x="900" y="16" className="f-mono" fontSize="11" fill="var(--sodium)">
          payoutTo: &quot;bank&quot;
        </text>
        <text x="900" y="272" className="f-mono" fontSize="11" fill="var(--sodium)">
          payoutTo: &quot;wallet&quot;
        </text>

        {/* ── Bank branch ──────────────────────────────────────────────────── */}
        {/* The glows follow the route the order actually took this run, so the
            branch it ignored stays drawn but unlit rather than claiming a
            settlement that did not happen. */}
        <Node
          x={900}
          y={25}
          w={160}
          title="CPN QUOTE"
          lines={["pinned to €P"]}
          accent="var(--sodium)"
          glow={bank && pos.stop === 2}
        />
        <path
          d="M1060,60 L1184,60"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          markerEnd="url(#rivo-arrow)"
          className="rail-path"
          style={{ ["--rail-len" as string]: 124, transitionDelay: "640ms" }}
        />
        <Node x={1190} y={25} w={240} title="LOCAL BANK ACCOUNT" accent="var(--verdigris)" glow={bank && settled} />

        {/* ── Wallet branch ────────────────────────────────────────────────── */}
        <Node
          x={900}
          y={185}
          w={160}
          title="FLOORED SWAP"
          lines={["USDC → EURC"]}
          accent="var(--verdigris)"
          glow={!bank && pos.stop === 2}
        />
        <path
          d="M1060,220 L1184,220"
          fill="none"
          stroke="var(--verdigris)"
          strokeWidth="1.5"
          markerEnd="url(#rivo-arrow)"
          className="rail-path"
          style={{ ["--rail-len" as string]: 124, transitionDelay: "700ms" }}
        />
        <text x="1068" y="208" className="f-mono" fontSize="10" fill="var(--ash)">
          stopLimit = €P
        </text>
        <Node x={1190} y={185} w={240} title="EURC ON ARC" accent="var(--verdigris)" glow={!bank && settled} />

        {/* ── The way back from EURC ───────────────────────────────────────── */}
        {/* Dashed, and dashed on purpose: Circle Mint is the only exit EURC has,
            and release() deliberately does not drive it. Someone has to redeem
            it — which is exactly what a broken line means on a diagram whose
            other lines are automatic. */}
        <path
          d="M1310,185 L1310,160"
          fill="none"
          stroke="var(--ash)"
          strokeOpacity="0.55"
          strokeWidth="1.25"
          strokeDasharray="3 4"
        />
        <path
          d="M1310,128 L1310,99"
          fill="none"
          stroke="var(--ash)"
          strokeOpacity="0.55"
          strokeWidth="1.25"
          strokeDasharray="3 4"
          markerEnd="url(#rivo-arrow-ash)"
        />
        <text x="1310" y="148" textAnchor="middle" className="f-mono" fontSize="10" fill="var(--ash)">
          REDEEM VIA CIRCLE MINT
        </text>

        {/* ── The order itself ─────────────────────────────────────────────── */}
        {coinPct !== null && (
          <g
            style={{
              offsetPath: `path("${PATHS[route]}")`,
              offsetDistance: `${pos.d * 100}%`,
              offsetRotate: "0deg",
            }}
          >
            <circle
              r={pos.stop !== null ? 6 : 5}
              fill={readout.color}
              style={{ transition: "fill 300ms ease-out, r 260ms ease-out" }}
            />
            <foreignObject x="-70" y={-36} width="140" height="22" style={{ overflow: "visible" }}>
              <div
                className="f-mono text-center text-[11px]"
                style={{
                  color: readout.color,
                  transition: "color 300ms ease-out",
                  textShadow: settled ? "0 0 18px color-mix(in oklab, var(--verdigris) 70%, transparent)" : "none",
                }}
              >
                {readout.text}
              </div>
            </foreignObject>
          </g>
        )}
      </svg>
    </div>
  );
}
