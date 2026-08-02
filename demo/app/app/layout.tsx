import { RiArrowRightUpLine, RiShieldCheckLine } from "@remixicon/react";
import AppNav from "../AppNav";
import Marquee from "../Marquee";
import WalletButton from "../WalletButton";
import { Button } from "@/components/ui/button";
import { ToneBadge } from "../_ui";

/**
 * Shell shared by both halves of the demo: a fixed header with the Market Demo
 * / Withdraw nav over a viewport-height column. Each page supplies its own
 * `<main>`, because the marketplace board caps its own height while the
 * withdraw page simply scrolls.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-muted/30">
      {/* Everything optional drops away as the viewport narrows, in order of
          how little it is needed: the tagline, then the badge, then the SDK
          link's label. The nav and the wallet control never go. */}
      <header className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2.5 sm:gap-4 sm:px-5 sm:py-3">
        <a href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="flex size-8 items-center justify-center bg-primary text-primary-foreground">
            <RiShieldCheckLine className="size-4" />
          </span>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight">RivoKit</h1>
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
            what keeps it centred as either side changes width. */}
        <div className="flex min-w-0 flex-1 justify-center">
          <AppNav />
        </div>

        <div className="flex shrink-0 items-center gap-2">
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

      <Marquee>
        Real on chain: order + locked FX, USDC into escrow, capture, floored swap, refund bridge-back. Catalog,
        shipping and courier are <span className="font-mono">mocked</span>.
      </Marquee>

      {children}
    </div>
  );
}
