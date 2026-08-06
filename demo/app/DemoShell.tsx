import AppNav from "./AppNav";
import DemoLock from "./DemoLock";
import RivoMark from "./RivoMark";
import WalletButton from "./WalletButton";
import { ToneBadge } from "./_ui";
// The landing page's display face, borrowed for exactly one line — see the
// tagline in `DemoFooter`. `next/font` dedupes the loader across imports, so
// this costs nothing on a route that already renders the landing page.
import { displaySerif } from "./landing/fonts";
import {
  ARC_TESTNET_CHAIN_ID, ARC_TESTNET_EXPLORER_URL, ARC_TESTNET_RPC_URL, CIRCLE_FAUCET_URL,
  EURC_ADDRESS, STABLEFX_ESCROW_ADDRESS, USDC_ADDRESS,
} from "../../src/constants/arc";

// Linked only when it is configured — a footer link to `/address/undefined` is
// worse than no link, and the demo runs against whichever escrow is deployed.
const ESCROW = process.env.NEXT_PUBLIC_RIVO_ESCROW_ADDRESS;

/**
 * The chrome every demo route wears: a sticky header carrying the nav and the
 * wallet control, and a footer carrying the links and the on-chain addresses.
 *
 * It lives here rather than in `app/layout.tsx` because `/sdk` is a sibling of
 * `/app`, not a child of it — and for a while that meant `/sdk` had no header at
 * all, so the SDK page was reachable from the demo but led nowhere back. One
 * shell, two layouts, no second copy to forget.
 *
 * `TOPBAR_VARS` is exported alongside because the header's own `min-h` and the
 * board's `calc()` in `/app` both read `--topbar`, and a variable declared in
 * one layout is not visible to the other. Both layouts spread this same string
 * on their outermost element, so the two values cannot drift apart. Two values
 * because the header wraps to a second row below `sm`, where the nav takes a
 * line of its own.
 */
export const TOPBAR_VARS = "[--topbar:5.75rem] sm:[--topbar:3.75rem]";

export function DemoHeader() {
  return (
    // Everything optional drops away as the viewport narrows, in order of how
    // little it is needed: the tagline, then the badge. The nav and the wallet
    // control never go.
    // Below `sm` that is not enough — logo + nav + wallet cannot all fit on one
    // line, and since every Button carries `shrink-0` the overflow lands on top
    // of its neighbour rather than compressing. So the row wraps and the nav
    // takes a line of its own; from `sm` up it is one row again, unchanged.
    <header className="sticky top-0 z-30 flex min-h-(--topbar) shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2.5 sm:flex-nowrap sm:gap-4 sm:px-5 sm:py-3">
      {/* Site identity, not the page heading — each route owns its own <h1>, so
          this stays a <span> and the pages are not left with two. */}
      <a href="/" className="flex min-w-0 items-center gap-2.5 sm:shrink-0">
        {/* Above the fold and the first thing painted, so it is not lazy. */}
        <RivoMark className="size-8 shrink-0" priority />
        <div className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold tracking-tight">RivoKit</span>
          <span className="hidden text-xs text-muted-foreground sm:block">Cross-border settlement on Arc</span>
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
          single row: pushes this to the right edge. */}
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
        {/* Renders nothing in local development — see DemoLock. */}
        <DemoLock />
        <WalletButton />
      </div>
    </header>
  );
}

/** The builder's accounts, on the identity row rather than in a column. */
const SOCIAL = [
  { label: "Discord", href: "https://discord.com/users/393224117371011082" },
  { label: "Twitter", href: "https://x.com/agquais" },
  { label: "LinkedIn", href: "https://www.linkedin.com/in/yaziedbachtiar/" },
] as const;

/**
 * The demo's closing band: who this is, where to go, and what it ran on.
 *
 * The light counterpart of the landing page's dark one. They are deliberately
 * the same object in two keys — same three link groups, same chain block, same
 * pair of qualifiers on the last rule — because a reader crossing from `/` to
 * `/app` should not feel they have left the site.
 *
 * It used to be two dense inline rows, laid out that way to stay short. Short
 * was the wrong thing to optimise: this sits below a board that already
 * scrolls, so nothing here is competing for a fold, and the compression cost
 * the one thing a footer is for — being scannable. Columns, with air.
 *
 * The addresses belong here and nowhere else: "which USDC, which escrow" is the
 * question a testnet demo gets asked most, and no other screen answers it.
 */
export function DemoFooter() {
  return (
    <footer
      className={`${displaySerif.variable} border-t bg-background text-sm text-muted-foreground`}
      // The landing page's drafting-paper dots, inverted for a light field and
      // on the same 26px pitch. It is the one visual thing the two footers
      // share besides their structure, and it is what stops this band from
      // reading as an empty area below the app rather than as its ending.
      style={{
        backgroundImage:
          "radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--foreground) 7%, transparent) 1px, transparent 0)",
        backgroundSize: "26px 26px",
      }}
    >
      {/*
       * Full bleed, and padded to the HEADER's rhythm (`px-3 sm:px-5`) rather
       * than to a rhythm of its own.
       *
       * It was centred inside `max-w-[1440px]`, which is a sensible measure for
       * a document and the wrong one here: nothing else in this shell is
       * centred. The header spans the viewport, and so does the board (`p-3` on
       * its own main). On a wide screen that left the footer visibly inset from
       * both — a band that looked like it belonged to a different page.
       */}
      <div className="px-3 py-8 sm:px-5">
        {/* ── Identity ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b pb-7">
          {/* The mark spans both lines and the text column starts beside it, so
              the tagline aligns under the wordmark rather than under the logo —
              which is what makes the two read as one signature. */}
          <div className="flex min-w-0 items-start gap-3">
            <RivoMark className="size-9 shrink-0" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-2xl font-bold tracking-tight text-foreground">RivoKit</span>
                <ToneBadge tone="warning" className="rounded-full px-3 py-0.5">
                  Arc Testnet · Unaudited
                </ToneBadge>
              </div>
              {/*
               * Serif italic, and the only serif in the whole demo. That is the
               * point: every other word on these screens is UI, and this one is
               * the product's own sentence. Setting it in the same grotesk as
               * the buttons around it is what made it read as another label.
               */}
              <p className="mt-1 font-[family-name:var(--landing-serif)] text-[17px] italic leading-snug text-foreground/85">
                Multi-chain USDC in, a floored EURC guarantee out, a bank exit through CPN.
              </p>
            </div>
          </div>

          <nav aria-label="Social" className="flex shrink-0 items-center gap-2.5 text-[15px]">
            {SOCIAL.map(({ label, href }, i) => (
              <span key={href} className="flex items-center gap-2.5">
                {i > 0 && <span aria-hidden className="text-muted-foreground/40">•</span>}
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer me"
                  className="text-foreground/80 underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {label}
                </a>
              </span>
            ))}
          </nav>
        </div>

        {/* ── Where to go, and what it ran on ──────────────────────────── */}
        {/* The chain block is pushed to the far edge by the `1fr` between it
            and the link groups, so the three columns stay grouped instead of
            spreading across the whole width. Below `lg` the spacer collapses
            and everything simply stacks. */}
        <div className="grid grid-cols-2 gap-x-10 gap-y-8 pt-7 sm:grid-cols-3 lg:grid-cols-[auto_auto_auto_1fr_auto] lg:gap-x-12">
          <FooterGroup title="Demo">
            <FooterLink href="/">Overview</FooterLink>
            <FooterLink href="/app">Market demo</FooterLink>
            <FooterLink href="/app/withdraw">Withdraw</FooterLink>
            <FooterLink href="/sdk">SDK surface</FooterLink>
          </FooterGroup>

          <FooterGroup title="Project">
            <FooterLink href="https://github.com/0xsheyn/RivoKit">GitHub</FooterLink>
            {/* The repo README used to stand in for docs. `/docs` is a real
                route now, and a link that leaves the site for something the
                site has is a link pointing the wrong way. */}
            <FooterLink href="/docs">Docs</FooterLink>
            <FooterLink href="https://arc.network">Built on Arc</FooterLink>
            <FooterLink href={CIRCLE_FAUCET_URL}>Faucet</FooterLink>
          </FooterGroup>

          <FooterGroup title="Contract">
            {/* Only when it is configured — a link to `/address/undefined` is
                worse than no link, and the demo runs against whichever escrow
                is deployed. */}
            {ESCROW && <FooterLink href={`${ARC_TESTNET_EXPLORER_URL}/address/${ESCROW}`}>Escrow</FooterLink>}
            {/* StableFX's own escrow. RivoKit never calls it — FX goes through
                App Kit Swap — but it is where a settlement can be looked up,
                which is the only reason it is worth linking. */}
            <FooterLink href={`${ARC_TESTNET_EXPLORER_URL}/address/${STABLEFX_ESCROW_ADDRESS}`}>
              Settlement
            </FooterLink>
            <FooterLink href={`${ARC_TESTNET_EXPLORER_URL}/address/${USDC_ADDRESS}`}>USDC</FooterLink>
            <FooterLink href={`${ARC_TESTNET_EXPLORER_URL}/address/${EURC_ADDRESS}`}>EURC</FooterLink>
          </FooterGroup>

          <div aria-hidden className="hidden lg:block" />

          {/* Facts, not destinations — so they are not styled as links. */}
          <div className="col-span-2 min-w-0 space-y-4 sm:col-span-3 lg:col-span-1">
            <Fact label="Network">Arc Testnet · {ARC_TESTNET_CHAIN_ID}</Fact>
            <Fact label="RPC URL">{ARC_TESTNET_RPC_URL}</Fact>
            <Fact label="Explorer">{ARC_TESTNET_EXPLORER_URL}/</Fact>
          </div>
        </div>
      </div>

      {/*
       * What this is, and the exact limit of what was observed.
       *
       * The same pair the landing page ends on, in the same places. The right
       * half is the one sentence this project must never soften: CPN REPORTED
       * the payment complete. Nobody in this repo has watched euros land in a
       * bank account (LIMITATIONS.md), and a footer that says "COMPLETED" on
       * its own would be claiming they did.
       */}
      <div className="border-t bg-muted/30">
        <div className="flex flex-col gap-1.5 px-3 py-3.5 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-5 sm:text-left">
          <p>Testnet-stage sample software — not a licensed financial product</p>
          <p>CPN reported completed — not a bank statement</p>
        </div>
      </div>
    </footer>
  );
}

/** A column: an uppercase label with its links stacked beneath it. */
function FooterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <nav aria-label={title} className="min-w-0">
      <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">{title}</p>
      <div className="space-y-2">{children}</div>
    </nav>
  );
}

/** A labelled chain fact. Read, never clicked — hence no link affordance. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[15px]">{children}</p>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  // Same-origin routes navigate in place; everything else opens away. Decided
  // from the href rather than from a flag, so a link added later cannot get the
  // pair wrong — the old `external` prop was one more thing to remember.
  const external = !href.startsWith("/");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="block text-[15px] underline-offset-4 transition-colors hover:text-foreground hover:underline"
    >
      {children}
    </a>
  );
}
