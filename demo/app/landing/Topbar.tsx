import { RiExternalLinkLine } from "@remixicon/react";
import RivoMark from "../RivoMark";

/**
 * The five links worth a permanent slot, and the two actions. The footer imports
 * this same array rather than keeping its own copy — a second list is a second
 * thing to forget when a section is renamed.
 */
export const NAV = [
  // Rooted at "/" rather than bare fragments so the same bar works on /docs.
  // On the landing page itself the browser still treats these as same-document
  // fragment navigation — no reload.
  { href: "/#problem", label: "Problem" },
  { href: "/#capabilities", label: "What it does" },
  { href: "/#proof", label: "Proof" },
  { href: "/#roadmap", label: "Roadmap" },
  { href: "/docs", label: "Docs" },
] as const;

export default function Topbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-[color:var(--ash)]/20 bg-[color:var(--ink)]/85 backdrop-blur-md">
      {/* The warning travels with the bar. It used to sit at the top of the hero
          and scroll away after a screen — which is the wrong shape for a
          sentence that stays true the whole way down the page. */}
      {/* A fixed height rather than padding: the hero subtracts this bar's
          height to keep its own "SCROLL" marker above the fold, and that
          subtraction needs a number that does not drift with the font. h-7 →
          h-9, so Hero.tsx's calc() moved with it — 36 + 56 = 92, and 36 + 64 =
          100 from md.

          Sodium, the button's own colour, so the warning carries the same
          weight as the page's primary action instead of receding into a raised
          grey. Note this is ~2:1 against sodium — legible at a glance, below
          WCAG AA for body copy; `var(--ink)` would be ~9:1 if the strip should
          meet AA. The dot goes to ink for the same reason it existed: a sodium
          dot on a sodium field is not a dot.

          The `eyebrow` class is spelled out here rather than used, and that is
          the whole reason the text stayed grey the first time. `.rivo-landing
          .eyebrow` is two class selectors — specificity (0,2,0) — while
          Tailwind's `.text-white` is one, (0,1,0). The utility lost, silently,
          and `color: var(--ash)` won. Anything that needs to override a colour
          `.eyebrow` sets has to either out-specify it or not opt into it; this
          takes the second route. */}
      <div className="f-mono flex h-9 items-center justify-center gap-2 border-b border-[color:var(--ash)]/20 bg-[var(--sodium)] px-5 text-center text-[11px] font-medium uppercase tracking-[0.16em] text-white">
        <span className="size-1.5 shrink-0 rounded-full bg-[var(--ink)]/70" />
        TESTNET ONLY · UNAUDITED · DO NOT USE REAL FUNDS
      </div>

      {/* Three columns rather than flex: the middle one is centred against the
          bar, not against whatever the two sides happen to weigh today. */}
      <nav
        aria-label="Primary"
        className="mx-auto grid h-14 max-w-[1440px] grid-cols-[auto_1fr_auto] items-center gap-3 px-5 md:h-16 md:gap-6 md:px-16"
      >
        <a href="/#top" className="flex shrink-0 items-center gap-2">
          {/* `light`: this bar sits on --ink, where the blue mark measures
              2.0:1 and its indigo half 1.44:1. Same mark, lightness only. */}
          <RivoMark className="size-7 md:size-8" size={64} priority tone="light" />
          <span className="f-ui text-[22px] font-semibold leading-none text-[var(--bone)] md:text-[25px]">rivokit</span>
        </a>

        {/* Centred where it fits; below md it simply scrolls from the left, since
            a centred overflow hides its own first item in some browsers. */}
        <div className="-mx-1 flex min-w-0 items-center gap-x-5 overflow-x-auto px-1 [scrollbar-width:none] md:justify-center md:gap-x-8 [&::-webkit-scrollbar]:hidden">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              // py-2 is not spacing — it is the room the dotted rule is drawn
              // in. Without it the rule falls outside the link and the scroll
              // container clips it.
              //
              // Serif italic, not the UI grotesk: the links now share the face
              // the section headlines use, which is what ties the bar to the
              // page it sits on instead of reading as a separate chrome layer.
              // A point larger than the old sans, because an italic serif at
              // 13px sets visually smaller than a grotesk at the same size.
              className="nav-dotted link-step f-display whitespace-nowrap py-2 text-[14px] text-[var(--bone)]/70 md:text-[15px]"
            >
              {item.label}
            </a>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2 md:gap-3">
          <a
            href="https://github.com/0xsheyn/RivoKit"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repository"
            className="eyebrow btn-outline flex items-center gap-1.5 rounded-full border border-[color:var(--ash)]/30 px-2.5 py-1.5 md:px-3"
          >
            <span className="hidden md:inline">GITHUB</span>
            <RiExternalLinkLine className="size-3.5" />
          </a>
          {/* Hidden on the narrowest screens rather than shrunk to initials —
              the hero's own CTA is one scroll away and says the same thing. */}
          <a
            href="/#install"
            className="btn-solid hidden rounded-sm bg-[var(--sodium)] px-4 py-1.5 text-[13px] font-medium text-[var(--ink)] sm:block"
          >
            Get the SDK
          </a>
        </div>
      </nav>
    </header>
  );
}
