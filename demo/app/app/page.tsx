import { ArrowUpRight, ShieldCheck } from "lucide-react";
import Marketplace from "../Marketplace";
import WalletButton from "../WalletButton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const metadata = {
  title: "RivoKit — demo",
  description:
    "Cross-border settlement on Arc: multi-chain USDC in, floored EURC out. Testnet only.",
};

/**
 * Single-screen board: a fixed header over a grid of role columns — Buyer,
 * Seller, Host, Seller wallet. Nothing below the fold; each column scrolls on
 * its own.
 */
export default function Page() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-muted/30">
      <header className="flex shrink-0 items-center gap-4 border-b bg-background px-5 py-3">
        <a href="/" className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="size-4" />
          </span>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight">RivoKit</h1>
            <p className="text-xs text-muted-foreground">Cross-border settlement on Arc</p>
          </div>
        </a>

        <Badge variant="outline" className="hidden border-amber-200 bg-amber-50 text-amber-700 sm:inline-flex">
          Arc Testnet · unaudited
        </Badge>
        <p className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground xl:block">
          Real on chain: order + locked FX, USDC into escrow, capture, floored swap, refund bridge-back. Catalog,
          shipping and courier are <span className="font-mono">mocked</span>.
        </p>

        <div className="ml-auto flex items-center gap-2 xl:ml-0">
          <WalletButton />
          <Button asChild variant="outline" size="sm">
            <a href="/sdk">
              SDK surface
              <ArrowUpRight className="size-4" />
            </a>
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-3 xl:overflow-hidden">
        <Marketplace />
      </main>
    </div>
  );
}
