import { DemoFooter, DemoHeader, TOPBAR_VARS } from "../DemoShell";

/**
 * Shell shared by both halves of the demo: the common header and footer
 * (`DemoShell`) wrapped around a column that is at least a screen tall. Each
 * page supplies its own `<main>`.
 *
 * The board used to CLIP to exactly one screen (`h-[calc(...)]` +
 * `overflow-hidden`) and the role columns took their height from it. They no
 * longer do: a column is now as tall as seven order rows and says so in pixels
 * (`useRowCappedPanels` in `Marketplace.tsx`), which on a short laptop is more
 * than a screen. So the height here became a FLOOR — `min-h` — and the document
 * scrolls when the columns ask for more. Anything taller than the viewport was
 * unreachable under the old clip.
 *
 * The topbar stays sticky and stays OUTSIDE this column: a `sticky` element
 * measures itself against its nearest scrolling ancestor, and with the document
 * doing the scrolling that ancestor is the viewport, which is what pins it.
 *
 * That is what `--topbar` is for, and why it arrives from `DemoShell` rather
 * than being spelled out here: the variable feeds BOTH the header's `min-h` and
 * the `calc` below, and `/sdk` needs the same declaration for the same header.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`flex flex-col bg-muted/30 ${TOPBAR_VARS}`}>
      <DemoHeader />

      {/* The board: a screen minus the topbar at minimum, taller when the role
          columns need it. Each column still scrolls inside its own body — the
          cap is what makes it — but the cap is a row count now, not a viewport
          fraction, so the board can outgrow the screen. */}
      <div className="flex min-h-[calc(100dvh-var(--topbar))] flex-col">
        {/*
         * The one place the marketplace UI says which parts are not real. It is a
         * requirement, not decoration — the mocked pieces have to be named where
         * someone using the demo will see them — so it sits directly under the
         * topbar and wraps rather than scrolling or truncating: a label that can
         * hide its own second half is not a label. Static by design; this was a
         * marquee until 2026-08-02, and a moving one is exactly the kind that
         * gets read as chrome.
         */}
        <p className="shrink-0 border-b bg-muted/40 px-3 py-2 text-center text-sm font-bold text-chart-4 sm:px-5">
          Real on chain: order + locked FX, USDC into escrow, capture, floored swap, refund bridge-back. Catalog,
          shipping and courier are <span className="font-mono">mocked</span>.
        </p>

        {children}
      </div>

      <DemoFooter />
    </div>
  );
}
