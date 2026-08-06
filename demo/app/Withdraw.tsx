"use client";

import { useCallback, useEffect, useState } from "react";
import { RiWallet3Line } from "@remixicon/react";
import type { WithdrawSnapshot } from "../lib/board.server";
import { getJson, useLive } from "./live";
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
export default function Withdraw({ initial }: {
  /** Rendered on the server: every panel below starts with its data already in. */
  initial: WithdrawSnapshot;
}) {
  const [ownEurc, setOwnEurc] = useState<string | null>(null);
  const [eurcError, setEurcError] = useState<string | null>(null);
  const { sellerWallet, pick, candidates } = useSellerWallet();

  // ONE poll for the whole page — balances, seller, corridors, both histories,
  // Circle Mint. Twenty seconds rather than fifteen: nothing here moves unless
  // someone on this screen makes it move, and the panels that do call `refresh`
  // themselves.
  const { data, refresh } = useLive<WithdrawSnapshot>("/api/withdraw", initial, 20_000);
  const snap = data ?? initial;
  const bal = snap.balances;

  // The one thing the server cannot render: which wallet the seller picked is
  // in this browser's localStorage, so its balance has to be read from here.
  const refreshEurc = useCallback(() => {
    if (!sellerWallet) { setOwnEurc(null); setEurcError(null); return; }
    void getJson<{ eurc: string | null; eurcError: string | null }>(
      `/api/wallet?address=${sellerWallet}&fields=eurc`,
    ).then((r) => {
      if (!r.ok) { setEurcError(r.error); return; }
      if (r.eurc != null) { setOwnEurc(r.eurc); setEurcError(null); }
      // A failed read is not an empty wallet — say which one it was.
      else setEurcError(r.eurcError ?? "unavailable");
    });
  }, [sellerWallet]);

  useEffect(() => {
    refreshEurc();
    const id = setInterval(refreshEurc, 20_000);
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
      {/* Balances and the Mint top-up sit on one row: both are about the EURC
          the seller already holds, and neither is an exit. No `items-start`
          here, unlike the exits below — the grid's default `stretch` is what
          makes the pair one symmetric block, both cards as tall as the taller
          of the two. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-bold">
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
                ? <span className="font-mono text-sm">{shortAddr(sellerWallet)}</span>
                : <span className="text-sm font-normal text-muted-foreground">none chosen</span>} />
          </CardContent>

          {!sellerWallet && (
            <CardContent>
              <SellerWalletPicker candidates={candidates} onPick={pick} />
            </CardContent>
          )}

          <CardFooter>
            <p className="text-sm text-muted-foreground">
              {sellerWallet
                ? <>The settlement wallet runs the floored swap and forwards the floor to the seller wallet — so it is
                  a <span className="font-medium text-foreground">hop</span>, not the destination.</>
                : <>No second wallet chosen, so the settlement wallet keeps the floored EURC itself.</>}
            </p>
          </CardFooter>
        </Card>

        {/* EURC on Arc into the Mint EUR balance — the step that has to happen
            before the redemption panel below has anything to redeem. The
            deposit address comes from the page's one read; this panel used to
            ask Circle for it a second time, for the same answer MintRedeem was
            already fetching. */}
        <SendEurcToMint sellerWallet={sellerWallet} balanceMinor={ownEurc}
          deposit={snap.mint?.deposit ?? null}
          onSent={() => { refreshEurc(); refresh(); }} />
      </div>

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

      {/* Each exit keeps its history directly underneath it — the CPN column's
          one covers both ways a CPN payment can happen, the manual cash-out
          above it and the automatic payout at the end of a bank-bound order, so
          it is titled for all payments rather than for this panel. One flat grid
          rather than two stacked columns, because only siblings on the same row
          can be made the same height. The DOM order stays exit-then-its-history
          so the single-column layout below `lg` still reads in pairs; the
          explicit row/column placement is what splits it into two rows above
          it. The exits stretch to match each other, the histories keep their
          own heights (`self-start`) — they grow with the number of rows, and
          padding the shorter one out to the taller buys nothing. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <SellerCashout className="lg:col-start-1 lg:row-start-1"
          corridors={snap.corridors} seller={snap.seller} onDone={refresh} />
        <CpnHistory className="lg:col-start-1 lg:row-start-2 lg:self-start" rows={snap.cashouts} />
        <MintRedeem className="lg:col-start-2 lg:row-start-1" mint={snap.mint} onDone={refresh} />
        <MintHistory className="lg:col-start-2 lg:row-start-2 lg:self-start" rows={snap.mint?.payouts ?? null} />
      </div>
    </div>
  );
}
