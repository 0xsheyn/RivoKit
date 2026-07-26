"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { LogOut, Wallet } from "lucide-react";
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
        {error && <span className="hidden text-xs text-red-600 lg:inline">{error.message.slice(0, 60)}</span>}
        <Button size="sm" disabled={isPending || !injected} onClick={() => injected && connect({ connector: injected })}>
          <Wallet className="size-4" />
          {isPending ? "Connecting…" : "Connect wallet"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-card py-1 pl-3 pr-1 shadow-xs">
      <span className="flex items-center gap-2 text-xs">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        <span className="font-mono text-foreground">{shortAddr(address!)}</span>
        <span className="text-muted-foreground">
          Arc <b className="tabular-nums text-foreground">{usd(arcUsdc)}</b> USDC
        </span>
      </span>
      <Button variant="ghost" size="xs" onClick={() => disconnect()} aria-label="Disconnect wallet">
        <LogOut className="size-3.5" />
      </Button>
    </div>
  );
}
