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
    <div className="rounded-lg border border-sky-200 bg-sky-50/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase text-sky-700">
          <Landmark className="size-3.5" /> Circle Mint — redeem ke bank
        </span>
        <span className="text-[10px] text-muted-foreground">
          saldo <b className="tabular-nums text-foreground">{usd ? two(usd.amount) : "…"}</b> {usd?.currency ?? ""}
        </span>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Leg akhir jalur StableFX: EURC→EUR (di sandbox: USD) diredeem 1:1 ke rekening bank. Melengkapi CPN.
      </p>

      {deposit?.address && (
        <div className="mt-2 rounded-md border bg-card p-2 text-[9px] text-muted-foreground">
          <span className="font-medium text-foreground">Isi saldo (deposit):</span> kirim USDC ke{" "}
          <span className="font-mono text-foreground">{deposit.address.slice(0, 10)}…{deposit.address.slice(-6)}</span> di{" "}
          {deposit.chains.join("/")}. <span className="text-amber-600">Arc perlu bridge CCTP dulu.</span>
        </div>
      )}

      <div className="mt-2 flex items-end gap-1.5">
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
          className="h-8 flex-1 text-[11px]" placeholder="jumlah" />
        <Button size="xs" variant="outline" onClick={() => setAmount(two(balNum))}>Semua</Button>
        <Button size="sm" disabled={pending || !enough} onClick={redeem}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Redeem"}
        </Button>
      </div>
      {amount !== "" && !enough && <p className="mt-1 text-[10px] text-amber-600">Jumlah melebihi saldo Mint.</p>}
      {error && <p className="mt-2 text-[10px] text-red-600">{error}</p>}

      {payout && (
        <div className="mt-2 flex items-center gap-1.5 rounded-md border bg-card p-2 text-[10px]">
          <CircleCheck className="size-3.5 text-emerald-600" />
          Payout {two(payout.amount)} {payout.currency} → {payout.bankName}
          <Badge variant="outline" className="ml-auto text-[9px]">{payout.status}</Badge>
        </div>
      )}
    </div>
  );
}
