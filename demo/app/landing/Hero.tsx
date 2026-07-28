"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import HeroRail from "./HeroRail";

const RAIL_DONE = 900;
const COIN_START = 1100;
const COIN_END = 2400;

export default function Hero() {
  const [phase, setPhase] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [runId, setRunId] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
  }, []);

  // rAF is frozen while the tab is hidden, so a run started on a background
  // load would stall part-way through and never finish. Hold the clock until
  // the page is actually visible, then start it from that first frame.
  useEffect(() => {
    if (reducedMotion) {
      setPhase(COIN_END);
      return;
    }
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const elapsed = now - start;
      if (elapsed >= COIN_END) {
        setPhase(COIN_END);
        return;
      }
      setPhase(elapsed);
      rafRef.current = requestAnimationFrame(tick);
    };
    const startRun = () => {
      setPhase(0);
      start = null;
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
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [reducedMotion, runId]);

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
    <section className="relative flex min-h-screen flex-col overflow-hidden">
      <div className="eyebrow flex items-center gap-2 border-b border-[color:var(--ash)]/20 bg-[var(--ink-raised)] px-5 py-2">
        <span className="size-1.5 rounded-full bg-[var(--sodium)]" />
        TESTNET ONLY · UNAUDITED · DO NOT USE REAL FUNDS
      </div>

      <nav className="mx-auto flex w-full max-w-[1440px] items-center justify-between px-5 py-5 md:px-16">
        <div className="eyebrow">RIVOKIT</div>
        <div className="flex items-center gap-3">
          <a
            href="https://github.com/0xsheyn/RivoKit"
            target="_blank"
            rel="noopener noreferrer"
            className="eyebrow flex items-center gap-1.5 rounded-full border border-[color:var(--ash)]/30 px-3 py-1.5 hover-step"
          >
            GITHUB
            <ExternalLink className="size-3.5" />
          </a>
          <a
            href="#install"
            className="rounded-sm bg-[var(--sodium)] px-4 py-1.5 text-[13px] font-medium text-[var(--ink)]"
          >
            Get the SDK
          </a>
        </div>
      </nav>

      <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col justify-center px-5 md:px-16">
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">MULTI-CHAIN USDC IN</span>
          <span className="eyebrow hidden text-right sm:block">LOCAL CURRENCY OUT · SEPA · PIX · SPEI · WIRE</span>
        </div>

        <div className="relative">
          {/* Never gated on the animation clock: the page's own name must be
              legible on the first paint, whatever the rAF loop is doing. */}
          <h1
            className="f-display wordmark-in select-none text-center leading-[0.92] text-[var(--bone)]"
            style={{ fontSize: "clamp(64px, 14vw, 200px)" }}
          >
            rivokit
          </h1>
          {/* The rail's viewBox is 1200×220, so under ~640px it renders about
              66px tall and its 11px labels land at ~3px — a smear behind the
              wordmark rather than a diagram. Below sm we tell the same route
              in type instead. */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 hidden -translate-y-1/2 sm:block">
            <HeroRail railDrawn={railDrawn} coinPct={coinPct} settled={settled} />
          </div>
        </div>

        <div className="f-mono mt-5 flex flex-col items-center gap-1.5 text-[11px] tracking-[0.14em] text-[var(--ash)] sm:hidden">
          <span>ETH · BASE · OP</span>
          <span className="text-[var(--verdigris)]">↓ ARC · ESCROW · FLOORED SWAP</span>
          <span>SEPA · PIX · SPEI · WIRE</span>
          <span
            className={`mt-1 text-[13px] tracking-normal ${
              settled ? "text-[var(--verdigris)]" : "text-[var(--sodium)]"
            }`}
          >
            {settled ? "€12.92" : "15.00 USDC"}
          </span>
        </div>

        <p className="f-mono mx-auto mt-6 max-h-5 text-center text-[11px] text-[var(--ash)]">{timerLabel}&nbsp;</p>

        <p className="mx-auto mt-4 max-w-2xl text-center text-[15px] leading-relaxed text-[var(--bone)]/85 sm:text-[18px]">
          One embed moves value from &ldquo;the payer pays USDC from any chain&rdquo; to &ldquo;the recipient is
          paid&rdquo; — with a floored FX quote, escrow, refunds, and a fiat exit.
        </p>

        <div className="mx-auto mt-8 flex flex-wrap items-center justify-center gap-3">
          <a
            href="#install"
            className="rounded-sm bg-[var(--sodium)] px-5 py-2.5 text-sm font-medium text-[var(--ink)]"
          >
            Get the SDK
          </a>
          <a
            href="/app"
            className="flex items-center gap-1.5 rounded-sm border border-[color:var(--ash)]/40 px-5 py-2.5 text-sm text-[var(--bone)] hover-step"
          >
            Watch a payment clear
            <ArrowUpRight className="size-4" />
          </a>
          {!reducedMotion && (
            <button
              type="button"
              onClick={() => setRunId((n) => n + 1)}
              className="eyebrow rounded-sm border border-transparent px-3 py-2.5 hover-step"
            >
              Run it again
            </button>
          )}
        </div>
      </div>

      <div className="eyebrow pb-6 text-center">SCROLL</div>
    </section>
  );
}
