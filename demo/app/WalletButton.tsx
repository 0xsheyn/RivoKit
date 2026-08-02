"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { RiLogoutBoxRLine, RiWallet3Line } from "@remixicon/react";
import { mpAddrArcUsdc } from "./marketplace.actions";
import { Button } from "@/components/ui/button";
import { shortAddr, usd } from "./_ui";

/**
 * Header wallet control. Optional by design: without a wallet the buyer is
 * signed by the server (testnet key); connected, the browser wallet becomes the
 * real payer and signs ERC-3009 itself.
 */
export default function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const injected = connectors.find((c) => c.type === "injected") ?? connectors[0];

  const [arcUsdc, setArcUsdc] = useState<string | null>(null);
  useEffect(() => {
    if (!isConnected || !address) {
      setArcUsdc(null);
      return;
    }
    mpAddrArcUsdc(address).then(setArcUsdc);
    const id = setInterval(() => mpAddrArcUsdc(address).then(setArcUsdc), 10_000);
    return () => clearInterval(id);
  }, [address, isConnected]);

  if (!isConnected) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="hidden text-xs text-destructive lg:inline">{error.message.slice(0, 60)}</span>}
        <Button size="sm" disabled={isPending || !injected} onClick={() => injected && connect({ connector: injected })}>
          <RiWallet3Line className="size-4" />
          {isPending ? "Connecting…" : "Connect wallet"}
        </Button>
      </div>
    );
  }

  return (
    // Sized and squared to match a `size="sm"` Button, because that is what sits
    // either side of it in the header: h-7 and the preset's square corners. The
    // disconnect button is `size="xs"` (24px), which leaves 2px of inset.
    <div className="flex h-7 items-center gap-2 rounded-none border bg-card pr-0.5 pl-2.5">
      <span className="flex items-center gap-2 text-xs">
        <span className="size-1.5 rounded-full bg-primary" />
        <span className="font-mono text-foreground">{shortAddr(address!)}</span>
        {/* The balance is the first thing to go on a narrow screen — the panels
            below show it too, the address is what identifies the session. */}
        <span className="hidden text-muted-foreground md:inline">
          Arc <b className="tabular-nums text-foreground">{usd(arcUsdc)}</b> USDC
        </span>
      </span>
      <Button variant="ghost" size="xs" onClick={() => disconnect()} aria-label="Disconnect wallet">
        <RiLogoutBoxRLine className="size-3.5" />
      </Button>
    </div>
  );
}
