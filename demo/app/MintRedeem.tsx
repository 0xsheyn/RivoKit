"use client";

import { useEffect, useState, useTransition } from "react";
import { CircleCheck, Landmark, Loader2 } from "lucide-react";
import {
  mintBalanceAction,
  mintRedeemAction,
  type MintBalanceView,
  type MintDepositView,
  type MintPayoutView,
} from "./mint.actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

const two = (v: string | number) => Number(v).toFixed(2);

/**
 * Circle Mint redemption — the euro-native path's final fiat leg (redeem the
 * Mint account balance to a bank). Complements CPN: this is the StableFX route
 * (USDC→EURC→Circle Mint→EUR bank). The sandbox account holds USD.
 */
export default function MintRedeem() {
  const [balances, setBalances] = useState<MintBalanceView[]>([]);
  const [deposit, setDeposit] = useState<MintDepositView | null>(null);
  const [amount, setAmount] = useState("10");
  const [payout, setPayout] = useState<MintPayoutView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = () => mintBalanceAction().then((r) => { if (r.ok) { setBalances(r.balances); setDeposit(r.deposit); } });
  useEffect(() => { load(); }, []);

  const usd = balances.find((b) => b.currency === "USD") ?? balances[0];
  const balNum = usd ? Number(usd.amount) : 0;
  const amtNum = Number(amount || "0");
  const enough = amtNum > 0 && amtNum <= balNum;

  const redeem = () =>
    start(async () => {
      setError(null);
      const r = await mintRedeemAction(amount);
      if (r.ok) { setPayout(r.payout); load(); }
      else setError(r.error);
    });

  return (
    <div className="rounded-lg border bg-card p-3 shadow-xs">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-sky-50 text-sky-600">
          <Landmark className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Circle Mint — redeem to a bank</div>
          <p className="truncate text-xs text-muted-foreground">StableFX's final leg, redeemed 1:1 (sandbox: USD)</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          <b className="tabular-nums text-foreground">{usd ? two(usd.amount) : "…"}</b> {usd?.currency ?? ""}
        </span>
      </div>

      {deposit?.address && (
        <div className="mt-3 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Top up:</span> send USDC to{" "}
          <span className="font-mono text-foreground">{deposit.address.slice(0, 10)}…{deposit.address.slice(-6)}</span> on{" "}
          {deposit.chains.join("/")}. <span className="text-amber-600">From Arc, bridge over CCTP first.</span>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
          className="h-8 flex-1 text-xs" placeholder="amount" aria-label="Redeem amount" />
        <Button size="xs" variant="ghost" onClick={() => setAmount(two(balNum))}>Max</Button>
        <Button size="sm" disabled={pending || !enough} onClick={redeem}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Redeem"}
        </Button>
      </div>
      {amount !== "" && balances.length > 0 && !enough && (
        <p className="mt-1.5 text-xs text-amber-600">More than the Mint balance.</p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {payout && (
        <div className="mt-3 flex items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs">
          <CircleCheck className="size-3.5 shrink-0 text-emerald-600" />
          <span className="truncate">Payout {two(payout.amount)} {payout.currency} → {payout.bankName}</span>
          <Badge variant="outline" className="ml-auto">{payout.status}</Badge>
        </div>
      )}
    </div>
  );
}
