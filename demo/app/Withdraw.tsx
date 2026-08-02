"use client";

import { useCallback, useEffect, useState } from "react";
import { RiWallet3Line } from "@remixicon/react";
import { mpAddrEurc, mpBalances, type Balances } from "./marketplace.actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import SellerCashout from "./SellerCashout";
import MintRedeem from "./MintRedeem";
import { CpnHistory, MintHistory } from "./CashoutHistory";
import SendEurcToMint from "./SendEurcToMint";
import { Metric, shortAddr, usd } from "./_ui";
import { useSellerWallet } from "./seller-wallet";
import SellerWalletPicker from "./SellerWalletPicker";

/**
 * The fiat exits, on their own route: one balance row over the two cash-out
 * panels. The seller wallet is the same second address the Seller panel
 * forwards the floored EURC to, and it can be chosen from here too — the
 * balance being blank because a choice was never made on another page is not a
 * state worth shipping.
 */
export default function Withdraw() {
  const [bal, setBal] = useState<Balances | null>(null);
  const [ownEurc, setOwnEurc] = useState<string | null>(null);
  const [eurcError, setEurcError] = useState<string | null>(null);
  const { sellerWallet, pick, candidates } = useSellerWallet();

  useEffect(() => {
    const read = () => mpBalances().then((b) => { if (b) setBal(b); });
    read();
    const id = setInterval(read, 15_000);
    return () => clearInterval(id);
  }, []);

  const refreshEurc = useCallback(() => {
    if (!sellerWallet) { setOwnEurc(null); setEurcError(null); return; }
    mpAddrEurc(sellerWallet).then((r) => {
      if (r.ok) { setOwnEurc(r.minor); setEurcError(null); }
      else setEurcError(r.error);
    });
  }, [sellerWallet]);

  useEffect(() => {
    refreshEurc();
    const id = setInterval(refreshEurc, 15_000);
    return () => clearInterval(id);
  }, [refreshEurc]);

  const ownEurcValue = () => {
    if (!sellerWallet) return <span className="font-normal text-muted-foreground">not set</span>;
    if (ownEurc != null) return `€${usd(ownEurc)}`;
    if (eurcError) return <span className="font-normal text-destructive">unavailable</span>;
    return <span className="font-normal text-muted-foreground">…</span>;
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiWallet3Line className="size-4 text-muted-foreground" />
            Seller balances · EURC on Arc
          </CardTitle>
          <CardDescription>
            Proceeds of the floored settlement, and the two exits below: CPN (USDC→local fiat) or Circle Mint (1:1
            bank redemption).
          </CardDescription>
          {sellerWallet && (
            <CardAction>
              <Button size="xs" variant="ghost" onClick={() => pick(null)}>Change</Button>
            </CardAction>
          )}
        </CardHeader>

        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Metric label="EURC · settlement wallet" value={`€${usd(bal?.sellerEurc)}`} />
          <Metric label="EURC · seller wallet" value={ownEurcValue()} />
          <Metric label="Seller wallet"
            value={sellerWallet
              ? <span className="font-mono text-xs">{shortAddr(sellerWallet)}</span>
              : <span className="text-xs font-normal text-muted-foreground">none chosen</span>} />
        </CardContent>

        {!sellerWallet && (
          <CardContent>
            <SellerWalletPicker candidates={candidates} onPick={pick} />
          </CardContent>
        )}

        <CardFooter>
          <p className="text-xs text-muted-foreground">
            {sellerWallet
              ? <>The settlement wallet runs the floored swap and forwards the floor to the seller wallet — so it is
                a <span className="font-medium text-foreground">hop</span>, not the destination.</>
              : <>No second wallet chosen, so the settlement wallet keeps the floored EURC itself.</>}
          </p>
        </CardFooter>
      </Card>

      {eurcError && (
        <Alert variant="destructive">
          <AlertDescription className="truncate">
            Could not read the seller wallet&apos;s EURC balance: {eurcError}
          </AlertDescription>
        </Alert>
      )}

      {sellerWallet && (
        <Alert>
          <AlertDescription>
            The cash-out below still uses the demo seller wallet (server key) unless you switch it to
            <span className="font-medium text-foreground"> My wallet</span> — the Permit2 approve and CPN submit are
            signed by whichever of the two you pick.
          </AlertDescription>
        </Alert>
      )}

      {/* Each exit keeps its own history directly underneath it. */}
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <SellerCashout />
          <CpnHistory />
        </div>
        <div className="flex flex-col gap-3">
          {/* Feeding the Mint balance sits directly above redeeming it: EURC on
              Arc in, EUR to a bank out, in the order they happen. */}
          <SendEurcToMint sellerWallet={sellerWallet} balanceMinor={ownEurc} onSent={refreshEurc} />
          <MintRedeem />
          <MintHistory />
        </div>
      </div>
    </div>
  );
}
