"use client";

import { useEffect, useState, useTransition } from "react";
import { ArrowRight, Banknote, CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import {
  cpnBroadcastAction,
  cpnCorridorsAction,
  cpnPrepareAction,
  cpnSellerBalanceAction,
  type BroadcastView,
  type PreparedView,
} from "./ramp.actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type Corridor = { key: string; label: string; currency: string; method: string; minUsdc: number };

const two = (decimal: string | number) => Number(decimal).toFixed(2);

const STATUS_TONE: Record<string, string> = {
  COMPLETED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FAILED: "border-red-200 bg-red-50 text-red-700",
  CRYPTO_FUNDS_PENDING: "border-sky-200 bg-sky-50 text-sky-700",
  FIAT_PAYMENT_INITIATED: "border-amber-200 bg-amber-50 text-amber-700",
};

/**
 * The seller's multi-currency fiat cash-out, embedded in the Seller panel. Reads
 * the seller wallet's accumulated USDC and off-ramps it via CPN to the chosen
 * corridor (EUR/SEPA, BRL/PIX, MXN/SPEI, USD/WIRE) — a single USDC→fiat
 * conversion, no EURC hop. Complements the EURC-floor/StableFX path, doesn't
 * replace it.
 */
export default function SellerCashout() {
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  const [corridorKey, setCorridorKey] = useState<string>("");
  const [balMinor, setBalMinor] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [prepared, setPrepared] = useState<PreparedView | null>(null);
  const [broadcast, setBroadcast] = useState<BroadcastView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "prepare" | "broadcast">(null);
  const [, start] = useTransition();

  useEffect(() => {
    cpnCorridorsAction().then((cs) => {
      setCorridors(cs);
      if (cs[0]) setCorridorKey(cs[0].key);
    });
  }, []);

  const loadBalance = (prefill = false) =>
    cpnSellerBalanceAction().then((r) => {
      if (!r.ok) return;
      setBalMinor(r.seller.usdcMinor);
      if (prefill) setAmount(two(Number(r.seller.usdcMinor) / 1e6));
    });
  useEffect(() => { loadBalance(true); }, []);

  const corridor = corridors.find((c) => c.key === corridorKey);
  const minUsdc = corridor?.minUsdc ?? 11;
  const balNum = balMinor ? Number(balMinor) / 1e6 : 0;
  const amtNum = Number(amount || "0");
  const enough = amtNum >= minUsdc && amtNum <= balNum;

  const pickCorridor = (key: string) => {
    setCorridorKey(key);
    setPrepared(null); setBroadcast(null); setConfirmed(false); setError(null);
  };

  const prepare = () =>
    start(async () => {
      setBusy("prepare"); setError(null); setBroadcast(null); setConfirmed(false);
      const r = await cpnPrepareAction(amount, corridorKey);
      if (r.ok) setPrepared(r.prepared);
      else { setPrepared(null); setError(r.error); }
      setBusy(null);
    });

  const doBroadcast = () => {
    if (!prepared) return;
    start(async () => {
      setBusy("broadcast"); setError(null);
      const r = await cpnBroadcastAction(prepared.paymentId);
      if (r.ok) { setBroadcast(r.result); loadBalance(); }
      else setError(r.error);
      setBusy(null);
    });
  };

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase text-emerald-700">
          <Banknote className="size-3.5" /> Pencairan ke fiat (CPN)
        </span>
        <span className="text-[10px] text-muted-foreground">
          saldo <b className="tabular-nums text-foreground">{balMinor ? two(balNum) : "…"}</b> USDC
        </span>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        USDC hasil jualan → mata uang lokal di bank. Satu konversi via CPN — melengkapi jalur EUR/StableFX.
      </p>

      {/* Corridor selector */}
      <div className="mt-2 flex flex-wrap gap-1">
        {corridors.map((c) => (
          <button key={c.key} onClick={() => pickCorridor(c.key)}
            className={cn(
              "rounded-md border px-2 py-1 text-[10px] transition",
              c.key === corridorKey ? "border-emerald-400 bg-emerald-100 text-emerald-800" : "border-border bg-card hover:bg-accent",
            )}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-end gap-1.5">
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
          className="h-8 flex-1 text-[11px]" placeholder="jumlah USDC" />
        <Button size="xs" variant="outline" onClick={() => setAmount(two(balNum))}>Semua</Button>
        <Button size="sm" disabled={busy !== null || !enough || !corridorKey} onClick={prepare}>
          {busy === "prepare" ? <Loader2 className="size-3.5 animate-spin" /> : "Cairkan"}
        </Button>
      </div>
      {amount !== "" && !enough && (
        <p className="mt-1 text-[10px] text-amber-600">
          {amtNum < minUsdc ? `Min ${minUsdc} USDC untuk ${corridor?.currency ?? "koridor ini"}.` : "Melebihi saldo penjual."}
        </p>
      )}
      {error && <p className="mt-2 text-[10px] text-red-600">{error}</p>}

      {prepared && !broadcast && (
        <div className="mt-2 space-y-2 rounded-md border bg-card p-2">
          <div className="flex items-center justify-center gap-2 text-xs font-semibold">
            <span>{two(prepared.source.amount)} USDC</span>
            <ArrowRight className="size-3 text-muted-foreground" />
            <span className="text-emerald-600">{two(prepared.destination.amount)} {prepared.destination.currency}</span>
          </div>
          <div className="text-center text-[10px] text-muted-foreground">
            fee {prepared.fee} {prepared.feeCurrency} · margin {prepared.spreadBps} bps · {prepared.status}
          </div>
          <label className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            <span><TriangleAlert className="mr-0.5 inline size-3 text-amber-600" />Broadcast <strong>tak-balik</strong> — USDC penjual keluar (dana testnet).</span>
          </label>
          <Button size="sm" variant="destructive" className="w-full" disabled={!confirmed || busy !== null} onClick={doBroadcast}>
            {busy === "broadcast" ? <><Loader2 className="size-3.5 animate-spin" /> Broadcast…</> : "Broadcast (tak-balik)"}
          </Button>
        </div>
      )}

      {broadcast && (
        <div className="mt-2 space-y-1.5 rounded-md border bg-card p-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium">
            {broadcast.finalStatus === "COMPLETED"
              ? <CircleCheck className="size-3.5 text-emerald-600" />
              : <TriangleAlert className="size-3.5 text-amber-600" />}
            Pencairan
            <Badge variant="outline" className={cn("ml-auto text-[10px]", STATUS_TONE[broadcast.finalStatus])}>
              {broadcast.finalStatus || "—"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-[9px] text-muted-foreground">
            {broadcast.lifecycle.map((s, i) => (
              <span key={s} className="flex items-center gap-1">
                {i > 0 && <ArrowRight className="size-2.5" />}
                <span className="rounded bg-muted px-1 py-0.5 font-mono">{s}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
