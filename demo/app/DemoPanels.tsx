"use client";

import { useEffect, useState, useTransition } from "react";
import {
  createOrderAction, fundAction, releaseAction, refundAction, snapshotAction,
  type ActionResult, type Snapshot,
} from "./actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const WEDGES = [
  { value: "contractor_payout", label: "Kontraktor / payout B2B" },
  { value: "digital_goods", label: "Digital goods / SaaS" },
] as const;

const EUR = (minor: string | null) => (minor == null ? "—" : `€${(Number(minor) / 1e6).toFixed(2)}`);
const USDC = (minor: string | null) => (minor == null ? "—" : `${(Number(minor) / 1e6).toFixed(4)} USDC`);

const txUrl = (chain: string | null, hash: string) =>
  chain === "Ethereum_Sepolia"
    ? `https://sepolia.etherscan.io/tx/${hash}`
    : `https://testnet.arcscan.app/tx/${hash}`;

const STATE_TONE: Record<string, string> = {
  created: "border-border bg-muted text-muted-foreground",
  funding_pending: "border-sky-200 bg-sky-50 text-sky-700",
  funded: "border-emerald-200 bg-emerald-50 text-emerald-700",
  settlement_pending: "border-amber-200 bg-amber-50 text-amber-700",
  released: "border-emerald-200 bg-emerald-50 text-emerald-700",
  refund_pending: "border-sky-200 bg-sky-50 text-sky-700",
  refunded: "border-border bg-muted text-muted-foreground",
  failed: "border-red-200 bg-red-50 text-red-700",
};

export default function DemoPanels() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [price, setPrice] = useState("1.50");
  const [wedge, setWedge] = useState<(typeof WEDGES)[number]["value"]>("digital_goods");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const apply = (r: ActionResult) => {
    if (r.ok) { setSnap(r.snapshot); setError(null); }
    else setError(r.error);
  };

  // Poll while an order exists and something is in flight, so intermediate
  // states (funding_pending, refund_pending) surface before the action resolves.
  useEffect(() => {
    const inFlight = snap && (pending || snap.state.endsWith("_pending"));
    if (!snap || !inFlight) return;
    const id = setInterval(() => { snapshotAction(snap.orderId).then(apply); }, 4000);
    return () => clearInterval(id);
  }, [snap, pending]);

  const run = (fn: () => Promise<ActionResult>) => start(async () => apply(await fn()));

  const state = snap?.state;
  const canCreate = !snap || state === "refunded" || state === "released";
  const canFund = state === "created";
  const canRelease = state === "funded";
  const canRefund = state === "funded" || state === "released";

  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Interactive demo — run the flow through the SDK
          </CardTitle>
          {state && (
            <Badge variant="outline" className={cn("font-mono", STATE_TONE[state] ?? "border-border bg-muted text-muted-foreground")}>
              {pending ? "…memproses" : state}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Testnet. The buyer is server-signed with a demo key (in production the buyer signs in their own wallet).
          Operasi on-chain butuh 1–2 menit.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          {/* Buyer */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium text-foreground">Buyer</h3>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted-foreground">
                priceEUR
                <Input value={price} onChange={(e) => setPrice(e.target.value)} disabled={!canCreate || pending}
                  className="mt-1 h-8 w-24 text-sm" />
              </label>
              <label className="text-xs text-muted-foreground">
                wedge
                <select value={wedge} onChange={(e) => setWedge(e.target.value as typeof wedge)} disabled={!canCreate || pending}
                  className="mt-1 block h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40">
                  {WEDGES.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                </select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" disabled={!canCreate || pending}
                onClick={() => run(() => createOrderAction(String(Math.round(parseFloat(price || "0") * 1e6)), wedge))}>
                createOrder
              </Button>
              <Button size="sm" variant="outline" disabled={!canFund || pending} onClick={() => run(() => fundAction(snap!.orderId))}>fund (gasless)</Button>
              <Button size="sm" variant="destructive" disabled={!canRefund || pending} onClick={() => run(() => refundAction(snap!.orderId))}>refund</Button>
            </div>
          </div>

          {/* Seller */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium text-foreground">Seller (penerima EURC)</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Release when access is granted or a milestone is approved. The recipient is guaranteed ≥ priceEUR, or the swap reverts.
            </p>
            <div className="mt-3">
              <Button size="sm" disabled={!canRelease || pending} onClick={() => run(() => releaseAction(snap!.orderId))}>
                release (capture → swap floor)
              </Button>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>
        )}

        {/* Inspector */}
        {snap && (
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-medium text-foreground">Execution Inspector</h3>
              <span className="font-mono text-xs text-muted-foreground">{snap.orderId}</span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
              <div><dt className="text-muted-foreground">priceEUR</dt><dd className="text-foreground">{EUR(snap.priceEUR)}</dd></div>
              <div><dt className="text-muted-foreground">usdcAmount</dt><dd className="text-foreground">{USDC(snap.usdcAmount)}</dd></div>
              <div><dt className="text-muted-foreground">wedge</dt><dd className="font-mono text-foreground">{snap.wedge}</dd></div>
              <div><dt className="text-muted-foreground">refund ke</dt><dd className="text-foreground">{snap.receivingChain}</dd></div>
            </dl>

            {snap.payments.length > 0 && (
              <ul className="mt-3 space-y-1 border-t pt-3">
                {snap.payments.map((p, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <span className="w-24 shrink-0 font-mono text-emerald-600">{p.kind}</span>
                    <span className="text-muted-foreground">{p.status}</span>
                    {p.txHash && p.txHash.startsWith("0x") && p.txHash.length > 20 ? (
                      <a href={txUrl(p.chain, p.txHash)} target="_blank" rel="noopener noreferrer"
                        className="break-all font-mono text-sky-600 hover:underline">
                        {p.txHash.slice(0, 10)}…{p.txHash.slice(-8)}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{p.txHash ?? "—"}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {snap.payout && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-amber-900">
                    payout {EUR(snap.payout.sourceAmount)} EURC → {EUR(snap.payout.targetAmount)} EUR
                  </span>
                  <Badge className="bg-amber-500 text-white">{snap.payout.label}</Badge>
                </div>
                <p className="mt-1 text-[11px] text-amber-800">{snap.payout.disclaimer}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
