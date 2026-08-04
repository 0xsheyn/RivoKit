"use client";

import { useEffect, useRef, useState } from "react";
import { RiArrowRightUpLine } from "@remixicon/react";
import HeroRail, { type Route } from "./HeroRail";

/**
 * How often a run takes the wallet branch instead of the bank.
 *
 * Not a half: the bank ending is the claim this page leads on, so it stays the
 * common case, and the wallet ending shows up often enough that nobody reads
 * the lower branch as decoration. The first run of a page load is always the
 * bank — partly so the first impression is the headline, partly because the
 * server rendered it that way and a coin flip during render would not survive
 * hydration.
 */
const WALLET_CHANCE = 0.35;

/**
 * The clock, in milliseconds.
 *
 * The first version ran the whole route in 1.3s, which is not a diagram — it is
 * a flicker. A reader has to find the order, follow it across three labelled
 * stations, wait with it at each one, and read a value that changes four times.
 * Eight seconds is what that takes at a pace you can actually watch — a third
 * of it spent standing still, since `HeroRail` gives each stop a dwell. The
 * rails finish drawing at ~1.5s, so the order sets off just after they land.
 */
const COIN_START = 1600;
const COIN_END = 9600;
/** How long the settled state holds before the order runs again. */
const SETTLE_HOLD = 2200;

export default function Hero() {
  const [phase, setPhase] = useState(0);
  const [route, setRoute] = useState<Route>("bank");
  const rafRef = useRef<number | null>(null);

  // The `prefers-reduced-motion` query used to be read here, into state that
  // gated this whole clock. It is gone rather than left dangling: the parts of
  // this hero the setting should still switch off — the escrow pulse, the rail
  // draw-in — are switched off in CSS, where the media query costs no state, no
  // re-render, and no restart of the animation when it resolves after mount.

  // rAF is frozen while the tab is hidden, so a run started on a background
  // load would stall part-way through and never finish. Hold the clock until
  // the page is actually visible, then start it from that first frame.
  //
  // It LOOPS, and it loops even under `prefers-reduced-motion`. That is a
  // deliberate departure, taken on the owner's explicit instruction after two
  // rounds of the alternative, and it is narrower than it sounds: what the OS
  // setting still switches off here is every DECORATIVE motion — the escrow's
  // pulse and the rails' draw-in, both handled in landing.css. What survives is
  // the order travelling its route, which is not decoration but the only
  // explanation of the product this hero offers. Nothing flashes, nothing
  // parallaxes, nothing spins; one small mark moves along one line over seven
  // seconds. Revisit this if the page ever gains motion that is merely pretty.
  useEffect(() => {
    let start: number | null = null;
    let from = 0;
    let timer: number | null = null;

    const tick = (now: number) => {
      if (start === null) start = now;
      const elapsed = from + (now - start);
      if (elapsed >= COIN_END) {
        setPhase(COIN_END);
        timer = window.setTimeout(() => {
          // Resume at COIN_START, not 0: `railDrawn` stays true, so only the
          // order replays.
          from = COIN_START;
          start = null;
          // Re-rolled per cycle rather than once, so the two endings are a
          // property of the product rather than of this page load.
          setRoute(Math.random() < WALLET_CHANCE ? "wallet" : "bank");
          rafRef.current = requestAnimationFrame(tick);
        }, SETTLE_HOLD);
        return;
      }
      setPhase(elapsed);
      rafRef.current = requestAnimationFrame(tick);
    };
    // The mount run keeps the server-rendered bank route, so hydration has
    // nothing to disagree with; every later cycle re-rolls inside `tick`.
    const startRun = () => {
      setPhase(0);
      start = null;
      from = 0;
      rafRef.current = requestAnimationFrame(tick);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisible);
      startRun();
    };

    if (document.visibilityState === "visible") startRun();
    else document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer != null) clearTimeout(timer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const railDrawn = phase > 0;
  const coinPct = phase >= COIN_START ? Math.min(1, (phase - COIN_START) / (COIN_END - COIN_START)) : null;
  const settled = phase >= COIN_END;
  const timerLabel =
    coinPct !== null && !settled
      ? `${((phase - COIN_START) / 1000).toFixed(1)}s`
      : settled
        ? "SETTLED"
        : "";

  return (
    // The sticky bar is in normal flow, so it eats from the first screen. Height
    // is known and fixed: 36px strip + 56px nav, 64px from md. `svh` rather than
    // `vh` so a mobile browser's collapsing URL bar does not crop the section.
    // These two numbers are coupled to Topbar.tsx's h-9 and h-14/md:h-16 — change
    // one and the "SCROLL" marker drifts off the fold.
    <section className="relative flex min-h-[calc(100svh-92px)] flex-col overflow-hidden md:min-h-[calc(100svh-100px)]">
      {/* The warning strip and the nav that used to open this section now live
          in Topbar.tsx, where they stay put as the page scrolls. Two wordmarks
          and two routes to #install were stacked at the top of the page. */}
      <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col justify-center px-5 py-10 md:px-16">
        {/* The 200px "rivokit" that used to open this screen is gone, on the
            owner's instruction, and the rail is what the hero now leads on.
            The name is not lost with it: the sticky bar carries the mark and
            the wordmark at every scroll position, which is a better place for
            an identity than a slab of type competing with the one graphic that
            explains the product. What the hero gains is the whole first screen
            for the route.

            The rail is still hidden below sm: at ~360px wide its labels would
            render at ~3px, and the type fallback underneath says the same
            thing.

            The in/out pair travels WITH the rail — two labels naming the ends
            of a diagram belong against the diagram, not a screen away from it.
            Eight pixels of gap is the whole point. */}
        <div className="pointer-events-none hidden sm:block">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="eyebrow">MULTI-CHAIN USDC IN</span>
            <span className="eyebrow text-right">LOCAL CURRENCY OUT · EUR/SEPA · USD/WIRE</span>
          </div>
          <HeroRail railDrawn={railDrawn} coinPct={coinPct} settled={settled} route={route} />
        </div>

        <div className="f-mono mt-5 flex flex-col items-center gap-1.5 text-[11px] tracking-[0.14em] text-[var(--ash)] sm:hidden">
          {/* The same three chains the rail draws, and the same three the demo
              actually enables — this line still said OP, which has never been a
              source chain here. */}
          <span>ETH · BASE · AVAX</span>
          <span className="text-[var(--verdigris)]">↓ ARC · ESCROW · FLOORED RELEASE</span>
          <span>EUR/SEPA · USD/WIRE</span>
          <span
            className={`mt-1 text-[13px] tracking-normal ${
              settled ? "text-[var(--verdigris)]" : "text-[var(--sodium)]"
            }`}
          >
            {settled ? (route === "bank" ? "€10.00 · BANK" : "€10.00 EURC") : "11.75 USDC"}
          </span>
        </div>

        <p className="f-mono mx-auto mt-6 max-h-5 text-center text-[11px] text-[var(--ash)]">{timerLabel}&nbsp;</p>

        {/* This sentence was already the hero's actual claim; with the wordmark
            gone it becomes the h1 as well. An <h1> is not optional — it is the
            page's one structural title, and dropping the heading along with the
            type would leave the document without one. It stays at body weight
            and body size on purpose: a headline sized to lead would just be the
            wordmark's problem again, one face further down. */}
        <h1 className="mx-auto mt-4 max-w-2xl text-center text-[15px] font-normal leading-relaxed text-[var(--bone)]/85 sm:text-[18px]">
          One embed moves value from &ldquo;the payer pays USDC from any chain&rdquo; to &ldquo;the recipient is
          paid&rdquo; — a floored quote, escrow, refunds, and a bank account at the end of{" "}
          <span className="f-mono text-[var(--sodium)]">release()</span>.
        </h1>

        <div className="mx-auto mt-8 flex flex-wrap items-center justify-center gap-3">
          <a
            href="#install"
            className="btn-solid rounded-sm bg-[var(--sodium)] px-5 py-2.5 text-sm font-medium text-[var(--ink)]"
          >
            Get the SDK
          </a>
          {/* The arrow leans further out on hover — the only thing on this page
              allowed to move, and it moves 2px, because an arrow that says
              "elsewhere" should say it a little louder when aimed at. */}
          <a
            href="/app"
            className="btn-outline group flex items-center gap-1.5 rounded-sm border border-[color:var(--ash)]/40 px-5 py-2.5 text-sm text-[var(--bone)]"
          >
            Payment Demo
            <RiArrowRightUpLine className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        </div>
      </div>

      <div className="eyebrow pb-6 text-center">SCROLL</div>
    </section>
  );
}
