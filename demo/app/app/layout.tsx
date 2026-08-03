import { RiArrowRightUpLine } from "@remixicon/react";
import AppNav from "../AppNav";
import RivoMark from "../RivoMark";
import WalletButton from "../WalletButton";
import { Button } from "@/components/ui/button";
import { ToneBadge } from "../_ui";
import {
  ARC_TESTNET_CHAIN_ID, ARC_TESTNET_EXPLORER_URL, CIRCLE_FAUCET_URL, EURC_ADDRESS, USDC_ADDRESS,
} from "../../../src/constants/arc";

// Linked only when it is configured — a footer link to `/address/undefined` is
// worse than no link, and the demo runs against whichever escrow is deployed.
const ESCROW = process.env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS;

/**
 * Shell shared by both halves of the demo: a fixed header with the Market Demo
 * / Withdraw nav over a column that is at least a screen tall. Each page
 * supplies its own `<main>`.
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
 * That is what `--topbar` is for: the variable feeds BOTH sides — `min-h` on
 * the header, the `calc` here — so the two cannot drift apart. Two values
 * because the header wraps to a second row below `sm`, where the nav takes a
 * line of its own.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col bg-muted/30 [--topbar:5.75rem] sm:[--topbar:3.75rem]">
      {/* Everything optional drops away as the viewport narrows, in order of
          how little it is needed: the tagline, then the badge, then the SDK
          link's label. The nav and the wallet control never go.
          Below `sm` that is not enough — logo + nav + wallet + SDK link cannot
          all fit on one line, and since every Button carries `shrink-0` the
          overflow lands on top of its neighbour rather than compressing. So the
          row wraps and the nav takes a line of its own; from `sm` up it is one
          row again, unchanged. */}
      <header className="sticky top-0 z-30 flex min-h-(--topbar) shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2.5 sm:flex-nowrap sm:gap-4 sm:px-5 sm:py-3">
          <a href="/" className="flex min-w-0 items-center gap-2.5 sm:shrink-0">
            {/* Above the fold and the first thing painted, so it is not lazy. */}
            <RivoMark className="size-8 shrink-0" priority />
            <div className="min-w-0 leading-tight">
              <h1 className="truncate text-sm font-semibold tracking-tight">RivoKit</h1>
              <p className="hidden text-xs text-muted-foreground sm:block">Cross-border settlement on Arc</p>
            </div>
          </a>

          {/* Amber, the same tone every "not settled yet / handle with care" badge
              in the demo carries. It is a caution, so it should not look like a
              neutral label. */}
          <ToneBadge tone="warning" className="hidden lg:inline-flex">
            Arc Testnet · unaudited
          </ToneBadge>

          {/* Centred between the badge and the wallet button, and the flex-1 is
              what keeps it centred as either side changes width. `order-last`
              only bites once the header wraps: it puts the nav on the second
              line, below the controls it would otherwise have collided with. */}
          <div className="order-last flex w-full min-w-0 justify-center sm:order-none sm:w-auto sm:flex-1">
            <AppNav />
          </div>

          {/* `ml-auto` does on the wrapped row what the nav's flex-1 does on the
              single row: pushes these to the right edge. */}
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
            <WalletButton />
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={
                <a href="/sdk" aria-label="SDK surface">
                  <span className="hidden sm:inline">SDK surface</span>
                  <RiArrowRightUpLine className="size-4" />
                </a>
              }
            />
          </div>
        </header>

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

      {/*
       * Two rows, below the fold. The columns it replaced were the same links
       * stacked, and stacking is what made it tall — laid out inline they carry
       * the identity block, all three link groups and the on-chain addresses in
       * the height a single column of four would have taken.
       *
       * The addresses belong here and nowhere else: "which USDC, which escrow"
       * is the question a testnet demo gets asked most, and no other screen in
       * the app answers it.
       */}
      <footer className="border-t bg-background px-3 py-3 text-xs text-muted-foreground sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <RivoMark className="size-5 shrink-0" />
            <span className="text-sm font-semibold text-foreground">RivoKit</span>
            <ToneBadge tone="warning">Arc Testnet · unaudited</ToneBadge>
            <span className="min-w-0">
              Multi-chain USDC in, a floored EURC guarantee out, a bank exit through CPN.
            </span>
          </div>
          {/* Exactly what was proven, worded as what was proven: CPN reported
              the payment complete. Nobody in this repo has watched euros land
              in a bank account, and the footer must not imply otherwise. */}
          <p className="min-w-0 font-mono">
            EUR/SEPA · 15.00 USDC → €12.92 · CPN payment <span className="text-foreground">COMPLETED</span>
          </p>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t pt-2.5">
          <FooterGroup title="Demo">
            <FooterLink href="/app">Market demo</FooterLink>
            <FooterLink href="/app/withdraw">Withdraw</FooterLink>
            <FooterLink href="/sdk">SDK surface</FooterLink>
            <FooterLink href="/">Overview</FooterLink>
          </FooterGroup>

          <FooterGroup title="Network">
            <span>
              chain <span className="font-mono text-foreground">{ARC_TESTNET_CHAIN_ID}</span>
            </span>
            {ESCROW && (
              <FooterLink href={`${ARC_TESTNET_EXPLORER_URL}/address/${ESCROW}`} external>Escrow</FooterLink>
            )}
            <FooterLink href={`${ARC_TESTNET_EXPLORER_URL}/address/${USDC_ADDRESS}`} external>
              USDC <span className="font-mono">{USDC_ADDRESS.slice(0, 8)}…</span>
            </FooterLink>
            <FooterLink href={`${ARC_TESTNET_EXPLORER_URL}/address/${EURC_ADDRESS}`} external>
              EURC <span className="font-mono">{EURC_ADDRESS.slice(0, 8)}…</span>
            </FooterLink>
            <FooterLink href={CIRCLE_FAUCET_URL} external>Faucet</FooterLink>
          </FooterGroup>

          <FooterGroup title="Project">
            <FooterLink href="https://github.com/0xsheyn/RivoKit" external>GitHub</FooterLink>
            <FooterLink href="https://github.com/0xsheyn/RivoKit#readme" external>Docs</FooterLink>
            <FooterLink href="https://github.com/0xsheyn/RivoKit/blob/main/LICENSE" external>Apache-2.0</FooterLink>
            <FooterLink href="https://arc.network" external>Built on Arc</FooterLink>
          </FooterGroup>

          <p className="ml-auto min-w-0">Testnet-stage sample software — not a licensed financial product.</p>
        </div>
      </footer>
    </div>
  );
}

/** A label and its links on one line, so a group costs a row rather than four. */
function FooterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="shrink-0 text-[10px] font-medium tracking-wide text-foreground/60 uppercase">{title}</span>
      {children}
    </div>
  );
}

function FooterLink({ href, external, children }: {
  href: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="inline-flex items-center gap-0.5 underline-offset-4 hover:text-foreground hover:underline"
    >
      {children}
      {external && <RiArrowRightUpLine className="size-3 shrink-0" />}
    </a>
  );
}
