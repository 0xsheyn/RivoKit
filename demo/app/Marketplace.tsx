"use client";

import { useEffect, useState, useTransition } from "react";
import { useAccount, useConnect, useDisconnect, useSignTypedData } from "wagmi";
import {
  Wallet, LogOut, ExternalLink, ShoppingCart, Store, Landmark, Truck, CheckCircle2, PenLine,
} from "lucide-react";
import { CATALOG, fmtEUR } from "../lib/catalog";
import {
  mpCheckout, mpPay, mpConfirm, mpDispute, mpShip, mpRelease, mpRefund, mpListOrders, mpBalances,
  mpAddrArcUsdc, mpAuthTypedData, mpPaySigned,
  type OrderView, type PaySource, type Balances,
} from "./marketplace.actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

const usd = (m: string | null) => (m == null ? "—" : `${(Number(m) / 1e6).toFixed(2)}`);
const num = (m: string | null | undefined) => (m == null ? 0 : Number(m) / 1e6);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const txUrl = (chain: string | null, h: string) =>
  chain === "Ethereum_Sepolia" ? `https://sepolia.etherscan.io/tx/${h}` : `https://testnet.arcscan.app/tx/${h}`;

const STAGES = ["Dibayar", "Dikirim", "Diterima", "Selesai"];
const STAGE_OF: Record<string, number> = {
  waiting_payment: -1, processing_payment: -1,
  paid: 0, shipped: 1, confirmed: 2, settling: 2, completed: 3,
  dispute: 1, refunding: 1, refunded: 1,
};
const TONE: Record<string, string> = {
  waiting_payment: "border-border bg-muted text-muted-foreground",
  processing_payment: "border-sky-200 bg-sky-50 text-sky-700",
  paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
  shipped: "border-sky-200 bg-sky-50 text-sky-700",
  confirmed: "border-amber-200 bg-amber-50 text-amber-700",
  dispute: "border-red-200 bg-red-50 text-red-700",
  settling: "border-amber-200 bg-amber-50 text-amber-700",
  refunding: "border-sky-200 bg-sky-50 text-sky-700",
  refunded: "border-border bg-muted text-muted-foreground",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

// Payment rails and the balance each draws from, vs the order's usdcAmount.
const RAILS: Array<{ id: PaySource; label: string; bal: (b: Balances) => number; fee?: number; note: string }> = [
  { id: "arc", label: "USDC di Arc", bal: (b) => num(b.buyerArcUsdc), note: "langsung, tercepat" },
  { id: "unified", label: "Unified Balance", bal: (b) => num(b.buyerGatewayUsdc), fee: 1, note: "Gateway spend → Arc (sub-detik)" },
  { id: "bridge", label: "Bridge Sepolia", bal: (b) => num(b.buyerSepUsdc), note: "CCTP ~44 dtk" },
];

function Tracker({ status }: { status: string }) {
  const cur = STAGE_OF[status] ?? -1;
  const branched = status === "dispute" || status.startsWith("refund");
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px]">
      {STAGES.map((s, i) => (
        <span key={s} className="flex items-center gap-1">
          <span className={cn("rounded px-1.5 py-0.5", i <= cur ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground")}>{s}</span>
          {i < STAGES.length - 1 && <span className="text-muted-foreground/50">›</span>}
        </span>
      ))}
      {branched && <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">sengketa</span>}
    </div>
  );
}

function TxList({ view }: { view: OrderView }) {
  if (!view.payments.length) return null;
  return (
    <ul className="mt-2 space-y-1 border-t pt-2">
      {view.payments.map((p, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-1.5 text-[10px]">
          <span className="w-16 shrink-0 font-mono text-emerald-600">{p.kind}</span>
          {p.txHash && p.txHash.length > 20
            ? <a href={txUrl(p.chain, p.txHash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono text-sky-600 hover:underline">{p.txHash.slice(0, 8)}…{p.txHash.slice(-6)}<ExternalLink className="size-2.5" /></a>
            : <span className="text-muted-foreground">{p.status}</span>}
        </li>
      ))}
    </ul>
  );
}

function StatusBadge({ v, busy }: { v: OrderView; busy: boolean }) {
  return (
    <Badge variant="outline" className={cn(TONE[v.status] ?? "border-border bg-muted text-muted-foreground", busy && "animate-pulse")}>
      {busy ? "…memproses" : v.statusLabel}
    </Badge>
  );
}

export default function Marketplace() {
  const [views, setViews] = useState<OrderView[]>([]);
  const [bal, setBal] = useState<Balances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const { address, isConnected } = useAccount();
  const [walletUsdc, setWalletUsdc] = useState<string | null>(null);
  useEffect(() => {
    if (!isConnected || !address) { setWalletUsdc(null); return; }
    mpAddrArcUsdc(address).then(setWalletUsdc);
  }, [address, isConnected]);

  const refresh = async () => {
    const [r, b] = await Promise.all([mpListOrders(), mpBalances()]);
    if (r.ok) { setViews(r.views); setError(null); } else setError(r.error);
    if (b) setBal(b);
    if (isConnected && address) mpAddrArcUsdc(address).then(setWalletUsdc);
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const live = views.some((v) => v.state.endsWith("_pending") || v.status === "processing_payment" || v.status === "refunding");
    if (!live && !pending) return;
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [views, pending]);

  const run = (id: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => { setBusyId(id); const r = await fn(); if (!r.ok && "error" in r) setError(r.error ?? "gagal"); await refresh(); setBusyId(null); });
  const busy = (id: string) => pending && busyId === id;

  return (
    <section className="space-y-5">
      <ConnectBar walletUsdc={walletUsdc} />

      {/* Balances */}
      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Dompet Buyer (USDC)</div>
            <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-sm">
              <span className="text-foreground">Arc <b className="tabular-nums">{usd(bal?.buyerArcUsdc ?? null)}</b></span>
              <span className="text-muted-foreground">Sepolia <span className="tabular-nums">{usd(bal?.buyerSepUsdc ?? null)}</span></span>
              <span className="text-muted-foreground">Gateway <span className="tabular-nums">{usd(bal?.buyerGatewayUsdc ?? null)}</span></span>
            </div>
          </div>
          <div className="sm:text-right">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Dompet Seller (EURC di Arc)</div>
            <div className="mt-1.5 text-sm font-semibold text-emerald-600 tabular-nums">€{usd(bal?.sellerEurc ?? null)}</div>
          </div>
        </CardContent>
      </Card>

      {/* Storefront */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Store className="size-4 text-muted-foreground" /> Etalase
            <span className="font-normal text-muted-foreground">— klik untuk memesan (buyer)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
            {CATALOG.map((p) => (
              <div key={p.id} className="flex flex-col rounded-lg border bg-card p-3 transition-shadow hover:shadow-sm">
                <div className="text-2xl">{p.emoji}</div>
                <div className="mt-1 text-sm font-medium text-foreground">{p.name}</div>
                <div className="text-[10px] text-muted-foreground">{p.blurb} · {p.seller}</div>
                <div className="mt-1 text-sm font-semibold text-emerald-600">{fmtEUR(p.priceEURMinor)}</div>
                <Button size="sm" className="mt-2 w-full" disabled={pending}
                  onClick={() => run(null, () => mpCheckout(p.id, isConnected ? address : undefined))}>
                  {isConnected ? "Beli (wallet-ku)" : "Beli sekarang"}
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>
      )}

      {/* Three role panels */}
      <div className="grid gap-4 lg:grid-cols-3">
        <BuyerPanel views={views} bal={bal} pending={pending} busy={busy} run={run}
          connectedAddress={isConnected ? address ?? null : null} walletUsdc={walletUsdc} />
        <HostPanel views={views} busy={busy} run={run} />
        <SellerPanel views={views} busy={busy} run={run} />
      </div>
    </section>
  );
}

// ── Connect wallet (optional) ────────────────────────────────────────────────

function ConnectBar({ walletUsdc }: { walletUsdc: string | null }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const injected = connectors.find((c) => c.type === "injected") ?? connectors[0];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Wallet className="size-4 shrink-0" />
        {isConnected
          ? <span>Wallet tersambung <span className="font-mono text-foreground">{short(address!)}</span> · Arc <b className="text-foreground tabular-nums">{usd(walletUsdc)}</b> USDC — belanja &amp; tanda tangan sendiri (gasless).</span>
          : <span>Mode default: buyer <b className="text-foreground">ditandatangani server</b> (kunci testnet). Sambungkan wallet untuk jadi <i>payer</i> nyata &amp; tanda tangan di browser.</span>}
      </div>
      {isConnected
        ? <Button variant="outline" size="sm" onClick={() => disconnect()}><LogOut className="size-4" />Putuskan</Button>
        : <Button size="sm" disabled={isPending || !injected} onClick={() => injected && connect({ connector: injected })}>
            <Wallet className="size-4" />{isPending ? "Menyambungkan…" : "Sambungkan wallet"}
          </Button>}
      {error && <span className="w-full text-[11px] text-red-600">{error.message.slice(0, 120)}</span>}
    </div>
  );
}

function Panel({ title, icon, accent, children }: { title: string; icon: React.ReactNode; accent?: string; children: React.ReactNode }) {
  return (
    <Card className={cn("gap-4 py-4", accent)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {icon} {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

type RunFn = (id: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) => void;

// ── Buyer ──────────────────────────────────────────────────────────────────

function BuyerPanel({ views, bal, pending, busy, run, connectedAddress, walletUsdc }: {
  views: OrderView[]; bal: Balances | null; pending: boolean; busy: (id: string) => boolean; run: RunFn;
  connectedAddress: string | null; walletUsdc: string | null;
}) {
  const [rail, setRail] = useState<Record<string, PaySource>>({});
  const [disputeFor, setDisputeFor] = useState<string | null>(null);
  const [reason, setReason] = useState("Barang tidak sesuai");
  const { signTypedDataAsync } = useSignTypedData();

  // Connected-wallet pay: fetch the ERC-3009 typed data, sign it in the browser
  // wallet, and hand the signature back for the operator to relay (gasless).
  const payWithWallet = (v: OrderView) =>
    run(v.id, async () => {
      const td = await mpAuthTypedData(v.id);
      if (!td.ok) return { ok: false, error: td.error };
      const m = td.typedData;
      let signature: `0x${string}`;
      try {
        signature = await signTypedDataAsync({
          domain: { ...m.domain, verifyingContract: m.domain.verifyingContract as `0x${string}` },
          types: m.types,
          primaryType: m.primaryType,
          message: {
            from: m.message.from as `0x${string}`, to: m.message.to as `0x${string}`,
            value: BigInt(m.message.value), validAfter: BigInt(m.message.validAfter),
            validBefore: BigInt(m.message.validBefore), nonce: m.message.nonce as `0x${string}`,
          },
        });
      } catch {
        return { ok: false, error: "Tanda tangan dibatalkan di wallet" };
      }
      return mpPaySigned(v.id, signature);
    });

  return (
    <Panel title="Buyer" icon={<ShoppingCart className="size-4" />}>
      {views.length === 0 && <p className="text-xs text-muted-foreground">Belum ada pesanan.</p>}
      {views.map((v) => {
        const need = num(v.usdcAmount);
        const sel = rail[v.id] ?? "arc";
        const mine = connectedAddress != null && v.payer.toLowerCase() === connectedAddress.toLowerCase();
        const walletEnough = num(walletUsdc) >= need;
        return (
          <div key={v.id} className="rounded-lg border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-lg">{v.product?.emoji ?? "📦"}</span>
                <div>
                  <div className="text-xs font-medium text-foreground">{v.product?.name ?? "Pesanan"}</div>
                  <div className="text-[10px] text-muted-foreground">{fmtEUR(v.priceEURMinor)} · bayar {usd(v.usdcAmount)} USDC</div>
                </div>
              </div>
              <StatusBadge v={v} busy={busy(v.id)} />
            </div>
            <div className="mt-2"><Tracker status={v.status} /></div>

            {v.status === "waiting_payment" && mine && (
              <div className="mt-2 rounded-md border border-sky-200 bg-sky-50 p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] font-medium text-sky-700"><PenLine className="size-3" />Order wallet-ku · tanda tangan ERC-3009 (gasless)</div>
                <div className="mt-1 text-[10px] text-muted-foreground">Butuh {usd(v.usdcAmount)} USDC di Arc · saldo wallet {usd(walletUsdc)}</div>
                <Button size="sm" className="mt-2 w-full" disabled={pending || !walletEnough} onClick={() => payWithWallet(v)}>
                  {walletEnough ? "Bayar & tanda tangan di wallet" : "Saldo USDC Arc wallet kurang"}
                </Button>
              </div>
            )}

            {v.status === "waiting_payment" && !mine && (
              <div className="mt-2 rounded-md border bg-muted/40 p-2.5">
                <div className="text-[10px] text-muted-foreground">Bayar pakai USDC dari:</div>
                <div className="mt-1.5 flex flex-col gap-1">
                  {RAILS.map((r) => {
                    const avail = bal ? r.bal(bal) : 0;
                    const enough = avail >= need + (r.fee ?? 0);
                    return (
                      <button key={r.id} disabled={!enough || pending} onClick={() => setRail((s) => ({ ...s, [v.id]: r.id }))}
                        className={cn(
                          "flex items-center justify-between rounded-md border px-2 py-1.5 text-left text-[10px] transition disabled:opacity-40",
                          sel === r.id && enough ? "border-primary bg-accent" : "border-border hover:bg-accent/60",
                        )}>
                        <span className="font-medium text-foreground">{sel === r.id && enough ? "● " : "○ "}{r.label}</span>
                        <span className={cn("tabular-nums", enough ? "text-muted-foreground" : "text-red-500")}>{avail.toFixed(2)} {enough ? `· ${r.note}` : "· kurang"}</span>
                      </button>
                    );
                  })}
                </div>
                <Button size="sm" className="mt-2 w-full" disabled={pending} onClick={() => run(v.id, () => mpPay(v.id, sel))}>
                  Bayar via {RAILS.find((r) => r.id === sel)?.label} (gasless)
                </Button>
              </div>
            )}

            {v.shippedResi && <p className="mt-2 text-[10px] text-muted-foreground">Resi <span className="font-mono text-foreground">{v.shippedResi}</span></p>}
            {v.disputeReason && <p className="mt-1 text-[10px] text-red-600">Sengketa: {v.disputeReason}</p>}

            <div className="mt-2 flex flex-wrap gap-1.5">
              {v.status === "shipped" && (
                <Button size="xs" variant="outline" disabled={pending} onClick={() => run(v.id, () => mpConfirm(v.id))}>
                  <CheckCircle2 className="size-3" />Pesanan diterima
                </Button>
              )}
              {["shipped", "paid", "confirmed"].includes(v.status) && (
                <Button size="xs" variant="outline" disabled={pending} onClick={() => setDisputeFor(disputeFor === v.id ? null : v.id)}
                  className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700">Sengketa</Button>
              )}
            </div>
            {disputeFor === v.id && (
              <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-red-200 bg-red-50 p-2">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 text-[11px]" />
                <Button size="xs" variant="destructive" disabled={pending} onClick={() => { run(v.id, () => mpDispute(v.id, reason)); setDisputeFor(null); }}>
                  Kirim ke host
                </Button>
              </div>
            )}
            {v.status === "completed" && <p className="mt-1 text-[10px] text-emerald-600">Selesai.</p>}
            <TxList view={v} />
          </div>
        );
      })}
    </Panel>
  );
}

// ── Host ───────────────────────────────────────────────────────────────────

function HostPanel({ views, busy, run }: { views: OrderView[]; busy: (id: string) => boolean; run: RunFn }) {
  const active = views.filter((v) => v.state !== "created");
  const settleable = active.filter((v) => (v.status === "confirmed" || v.status === "shipped") && !v.disputeReason);
  const disputes = active.filter((v) => v.status === "dispute");
  return (
    <Panel title="Host / Marketplace (otoritas)" icon={<Landmark className="size-4" />} accent="border-amber-200 bg-amber-50/40">
      <p className="text-[10px] text-amber-700">Hanya host yang release (→ seller) &amp; refund (→ buyer). Komisi 5% ilustratif.</p>

      {disputes.length > 0 && <div className="text-[11px] font-semibold uppercase text-red-600">Sengketa</div>}
      {disputes.map((v) => (
        <div key={v.id} className="rounded-lg border border-red-200 bg-red-50 p-3">
          <div className="text-xs font-medium text-foreground">{v.product?.emoji} {v.product?.name} · {fmtEUR(v.priceEURMinor)}</div>
          <p className="mt-0.5 text-[10px] text-red-600">{v.disputeReason}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="xs" variant="destructive" disabled={busy(v.id)} onClick={() => run(v.id, () => mpRefund(v.id))}>
              {busy(v.id) ? "…" : "Setujui refund"}
            </Button>
            <Button size="xs" variant="outline" disabled={busy(v.id)} onClick={() => run(v.id, () => mpRelease(v.id))}
              className="border-emerald-200 text-emerald-700 hover:bg-emerald-50">Lepas ke seller</Button>
          </div>
        </div>
      ))}

      <div className="text-[11px] font-semibold uppercase text-muted-foreground">Siap di-settle</div>
      {settleable.length === 0 && <p className="text-[10px] text-muted-foreground">Tak ada.</p>}
      {settleable.map((v) => {
        const price = num(v.priceEURMinor);
        return (
          <div key={v.id} className="rounded-lg border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">{v.product?.emoji} {v.product?.name}</span>
              <StatusBadge v={v} busy={busy(v.id)} />
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {fmtEUR(v.priceEURMinor)} − komisi €{(price * 0.05).toFixed(2)} = <span className="font-medium text-foreground">€{(price * 0.95).toFixed(2)}</span> · {v.buyerConfirmed ? "buyer ✓" : "auto"}
            </div>
            <Button size="sm" className="mt-2 w-full" disabled={busy(v.id)} onClick={() => run(v.id, () => mpRelease(v.id))}>
              {busy(v.id) ? "…settling" : "Rilis & settle → seller"}
            </Button>
          </div>
        );
      })}

      <Separator />
      <div className="text-[11px] font-semibold uppercase text-muted-foreground">Semua pesanan</div>
      {active.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5 text-[10px]">
          <span className="truncate text-foreground">{v.product?.emoji} {v.product?.name ?? v.id.slice(0, 12)}</span>
          <StatusBadge v={v} busy={busy(v.id)} />
        </div>
      ))}
    </Panel>
  );
}

// ── Seller ─────────────────────────────────────────────────────────────────

function SellerPanel({ views, busy, run }: { views: OrderView[]; busy: (id: string) => boolean; run: RunFn }) {
  const [resi, setResi] = useState<Record<string, string>>({});
  const relevant = views.filter((v) => v.state !== "created");
  return (
    <Panel title="Seller" icon={<Store className="size-4" />}>
      {relevant.length === 0 && <p className="text-xs text-muted-foreground">Belum ada pesanan dibayar.</p>}
      {relevant.map((v) => (
        <div key={v.id} className="rounded-lg border bg-card p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">{v.product?.emoji ?? "📦"}</span>
              <div>
                <div className="text-xs font-medium text-foreground">{v.product?.name ?? "Pesanan"}</div>
                <div className="text-[10px] text-muted-foreground">dijamin {fmtEUR(v.priceEURMinor)} EURC</div>
              </div>
            </div>
            <StatusBadge v={v} busy={busy(v.id)} />
          </div>
          {v.status === "paid" && (
            <div className="mt-2 flex gap-1.5">
              <Input value={resi[v.id] ?? "JNE-001"} onChange={(e) => setResi((s) => ({ ...s, [v.id]: e.target.value }))}
                className="h-8 w-28 text-[11px]" />
              <Button size="sm" variant="outline" disabled={busy(v.id)} onClick={() => run(v.id, () => mpShip(v.id, resi[v.id] ?? "JNE-001"))}
                className="border-sky-200 text-sky-700 hover:bg-sky-50">
                <Truck className="size-3.5" />Tandai dikirim
              </Button>
            </div>
          )}
          {v.status === "completed" && <p className="mt-1 text-[10px] text-emerald-600">Dibayar {fmtEUR(v.eurcOutMinor)} EURC · payout MOCK.</p>}
          {["shipped", "confirmed"].includes(v.status) && <p className="mt-1 text-[10px] text-muted-foreground">Menunggu konfirmasi / settlement.</p>}
          {v.status.startsWith("refund") && <p className="mt-1 text-[10px] text-muted-foreground">Dikembalikan ke buyer.</p>}
          <TxList view={v} />
        </div>
      ))}
    </Panel>
  );
}
