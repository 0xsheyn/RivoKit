"use client";

import { useEffect, useState, useTransition } from "react";
import { CATALOG, fmtEUR } from "../lib/catalog";
import {
  mpCheckout, mpPay, mpConfirm, mpDispute, mpShip, mpRelease, mpRefund, mpListOrders, mpBalances,
  type OrderView, type PaySource, type Balances,
} from "./marketplace.actions";

const usd = (m: string | null) => (m == null ? "—" : `${(Number(m) / 1e6).toFixed(2)}`);
const num = (m: string | null | undefined) => (m == null ? 0 : Number(m) / 1e6);
const txUrl = (chain: string | null, h: string) =>
  chain === "Ethereum_Sepolia" ? `https://sepolia.etherscan.io/tx/${h}` : `https://testnet.arcscan.app/tx/${h}`;

const STAGES = ["Dibayar", "Dikirim", "Diterima", "Selesai"];
const STAGE_OF: Record<string, number> = {
  waiting_payment: -1, processing_payment: -1,
  paid: 0, shipped: 1, confirmed: 2, settling: 2, completed: 3,
  dispute: 1, refunding: 1, refunded: 1,
};
const TONE: Record<string, string> = {
  waiting_payment: "border-neutral-600 text-neutral-300", processing_payment: "border-sky-500/40 text-sky-300",
  paid: "border-emerald-500/40 text-emerald-300", shipped: "border-sky-500/40 text-sky-300",
  confirmed: "border-amber-500/40 text-amber-300", dispute: "border-red-500/40 text-red-300",
  settling: "border-amber-500/40 text-amber-300", refunding: "border-sky-500/40 text-sky-300",
  refunded: "border-neutral-500 text-neutral-300", completed: "border-emerald-500/40 text-emerald-300",
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
          <span className={`rounded px-1 py-0.5 ${i <= cur ? "bg-emerald-500/15 text-emerald-300" : "bg-neutral-800 text-neutral-500"}`}>{s}</span>
          {i < STAGES.length - 1 && <span className="text-neutral-700">›</span>}
        </span>
      ))}
      {branched && <span className="rounded bg-red-500/15 px-1 py-0.5 text-red-300">sengketa</span>}
    </div>
  );
}

function TxList({ view }: { view: OrderView }) {
  if (!view.payments.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 border-t border-neutral-800 pt-1.5">
      {view.payments.map((p, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-1.5 text-[10px]">
          <span className="w-16 shrink-0 font-mono text-emerald-300/80">{p.kind}</span>
          {p.txHash && p.txHash.length > 20
            ? <a href={txUrl(p.chain, p.txHash)} target="_blank" rel="noopener noreferrer" className="font-mono text-sky-400 hover:underline">{p.txHash.slice(0, 8)}…{p.txHash.slice(-6)}</a>
            : <span className="text-neutral-600">{p.status}</span>}
        </li>
      ))}
    </ul>
  );
}

function Badge({ v, busy }: { v: OrderView; busy: boolean }) {
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${TONE[v.status] ?? "border-neutral-600 text-neutral-300"}`}>{busy ? "…memproses" : v.statusLabel}</span>;
}

export default function Marketplace() {
  const [views, setViews] = useState<OrderView[]>([]);
  const [bal, setBal] = useState<Balances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const refresh = async () => {
    const [r, b] = await Promise.all([mpListOrders(), mpBalances()]);
    if (r.ok) { setViews(r.views); setError(null); } else setError(r.error);
    if (b) setBal(b);
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
      {/* Balances */}
      <div className="grid gap-3 rounded-lg border border-neutral-800 bg-neutral-900/30 p-4 sm:grid-cols-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">Dompet Buyer (USDC)</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span className="text-neutral-200">Arc <b>{usd(bal?.buyerArcUsdc ?? null)}</b></span>
            <span className="text-neutral-400">Sepolia {usd(bal?.buyerSepUsdc ?? null)}</span>
            <span className="text-neutral-400">Gateway {usd(bal?.buyerGatewayUsdc ?? null)}</span>
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">Dompet Seller (EURC di Arc)</div>
          <div className="mt-1 text-sm text-emerald-300">€<b>{usd(bal?.sellerEurc ?? null)}</b></div>
        </div>
      </div>

      {/* Storefront */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">Etalase — klik untuk memesan (buyer)</div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CATALOG.map((p) => (
            <div key={p.id} className="flex flex-col rounded border border-neutral-800 bg-neutral-950/40 p-3">
              <div className="text-2xl">{p.emoji}</div>
              <div className="mt-1 text-sm font-medium text-neutral-100">{p.name}</div>
              <div className="text-[10px] text-neutral-500">{p.blurb} · {p.seller}</div>
              <div className="mt-1 text-sm font-semibold text-emerald-300">{fmtEUR(p.priceEURMinor)}</div>
              <button disabled={pending} onClick={() => run(null, () => mpCheckout(p.id))}
                className="mt-2 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-40">
                Beli sekarang
              </button>
            </div>
          ))}
        </div>
      </div>

      {error && <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-200">{error}</div>}

      {/* Three role panels */}
      <div className="grid gap-4 lg:grid-cols-3">
        <BuyerPanel views={views} bal={bal} pending={pending} busy={busy} run={run} />
        <HostPanel views={views} busy={busy} run={run} />
        <SellerPanel views={views} busy={busy} run={run} />
      </div>
    </section>
  );
}

function Panel({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border ${tone} bg-neutral-900/30 p-4`}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{title}</h3>
      <div className="mt-3 space-y-3">{children}</div>
    </div>
  );
}

type RunFn = (id: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) => void;

// ── Buyer ──────────────────────────────────────────────────────────────────

function BuyerPanel({ views, bal, pending, busy, run }: {
  views: OrderView[]; bal: Balances | null; pending: boolean; busy: (id: string) => boolean; run: RunFn;
}) {
  const [rail, setRail] = useState<Record<string, PaySource>>({});
  const [disputeFor, setDisputeFor] = useState<string | null>(null);
  const [reason, setReason] = useState("Barang tidak sesuai");

  return (
    <Panel title="🛒 Buyer" tone="border-neutral-800">
      {views.length === 0 && <p className="text-xs text-neutral-600">Belum ada pesanan.</p>}
      {views.map((v) => {
        const need = num(v.usdcAmount);
        const sel = rail[v.id] ?? "arc";
        return (
          <div key={v.id} className="rounded border border-neutral-800 bg-neutral-950/40 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-lg">{v.product?.emoji ?? "📦"}</span>
                <div>
                  <div className="text-xs text-neutral-100">{v.product?.name ?? "Pesanan"}</div>
                  <div className="text-[10px] text-neutral-500">{fmtEUR(v.priceEURMinor)} · bayar {usd(v.usdcAmount)} USDC</div>
                </div>
              </div>
              <Badge v={v} busy={busy(v.id)} />
            </div>
            <div className="mt-2"><Tracker status={v.status} /></div>

            {v.status === "waiting_payment" && (
              <div className="mt-2 rounded border border-neutral-800 bg-neutral-900/40 p-2">
                <div className="text-[10px] text-neutral-500">Bayar pakai USDC dari:</div>
                <div className="mt-1.5 flex flex-col gap-1">
                  {RAILS.map((r) => {
                    const avail = bal ? r.bal(bal) : 0;
                    const enough = avail >= need + (r.fee ?? 0);
                    return (
                      <button key={r.id} disabled={!enough || pending} onClick={() => setRail((s) => ({ ...s, [v.id]: r.id }))}
                        className={`flex items-center justify-between rounded border px-2 py-1 text-left text-[10px] transition disabled:opacity-40 ${sel === r.id && enough ? "border-emerald-500/50 bg-emerald-500/10" : "border-neutral-700 hover:bg-neutral-800"}`}>
                        <span className="text-neutral-200">{sel === r.id && enough ? "● " : "○ "}{r.label}</span>
                        <span className={enough ? "text-neutral-500" : "text-red-400/70"}>{avail.toFixed(2)} {enough ? `· ${r.note}` : "· kurang"}</span>
                      </button>
                    );
                  })}
                </div>
                <button disabled={pending} onClick={() => run(v.id, () => mpPay(v.id, sel))}
                  className="mt-2 w-full rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">
                  Bayar via {RAILS.find((r) => r.id === sel)?.label} (gasless)
                </button>
              </div>
            )}

            {v.shippedResi && <p className="mt-2 text-[10px] text-neutral-500">Resi <span className="font-mono text-neutral-300">{v.shippedResi}</span></p>}
            {v.disputeReason && <p className="mt-1 text-[10px] text-red-300">Sengketa: {v.disputeReason}</p>}

            <div className="mt-2 flex flex-wrap gap-1.5">
              {v.status === "shipped" && (
                <button disabled={pending} onClick={() => run(v.id, () => mpConfirm(v.id))}
                  className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">Pesanan diterima</button>
              )}
              {["shipped", "paid", "confirmed"].includes(v.status) && (
                <button disabled={pending} onClick={() => setDisputeFor(disputeFor === v.id ? null : v.id)}
                  className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200 hover:bg-red-500/20 disabled:opacity-40">Sengketa</button>
              )}
            </div>
            {disputeFor === v.id && (
              <div className="mt-2 flex flex-col gap-1.5 rounded border border-red-500/20 bg-red-500/5 p-2">
                <input value={reason} onChange={(e) => setReason(e.target.value)}
                  className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] text-neutral-100" />
                <button disabled={pending} onClick={() => { run(v.id, () => mpDispute(v.id, reason)); setDisputeFor(null); }}
                  className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200 hover:bg-red-500/20">Kirim ke host</button>
              </div>
            )}
            {v.status === "completed" && <p className="mt-1 text-[10px] text-emerald-300/80">Selesai.</p>}
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
    <Panel title="🏦 Host / Marketplace (otoritas)" tone="border-amber-500/20">
      <p className="text-[10px] text-amber-200/70">Hanya host yang release (→ seller) & refund (→ buyer). Komisi 5% ilustratif.</p>

      {disputes.length > 0 && <div className="text-[11px] font-medium uppercase text-red-400">Sengketa</div>}
      {disputes.map((v) => (
        <div key={v.id} className="rounded border border-red-500/30 bg-red-500/5 p-3">
          <div className="text-xs text-neutral-100">{v.product?.emoji} {v.product?.name} · {fmtEUR(v.priceEURMinor)}</div>
          <p className="mt-0.5 text-[10px] text-red-300">{v.disputeReason}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button disabled={busy(v.id)} onClick={() => run(v.id, () => mpRefund(v.id))}
              className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200 hover:bg-red-500/20 disabled:opacity-40">{busy(v.id) ? "…" : "Setujui refund"}</button>
            <button disabled={busy(v.id)} onClick={() => run(v.id, () => mpRelease(v.id))}
              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">Lepas ke seller</button>
          </div>
        </div>
      ))}

      <div className="text-[11px] font-medium uppercase text-neutral-500">Siap di-settle</div>
      {settleable.length === 0 && <p className="text-[10px] text-neutral-600">Tak ada.</p>}
      {settleable.map((v) => {
        const price = num(v.priceEURMinor);
        return (
          <div key={v.id} className="rounded border border-neutral-800 bg-neutral-950/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-neutral-100">{v.product?.emoji} {v.product?.name}</span>
              <Badge v={v} busy={busy(v.id)} />
            </div>
            <div className="mt-1 text-[10px] text-neutral-500">
              {fmtEUR(v.priceEURMinor)} − komisi €{(price * 0.05).toFixed(2)} = <span className="text-neutral-300">€{(price * 0.95).toFixed(2)}</span> · {v.buyerConfirmed ? "buyer ✓" : "auto"}
            </div>
            <button disabled={busy(v.id)} onClick={() => run(v.id, () => mpRelease(v.id))}
              className="mt-2 w-full rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">{busy(v.id) ? "…settling" : "Rilis & settle → seller"}</button>
          </div>
        );
      })}

      <div className="text-[11px] font-medium uppercase text-neutral-500">Semua pesanan</div>
      {active.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-950/40 px-2 py-1.5 text-[10px]">
          <span className="truncate text-neutral-300">{v.product?.emoji} {v.product?.name ?? v.id.slice(0, 12)}</span>
          <Badge v={v} busy={busy(v.id)} />
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
    <Panel title="🏬 Seller" tone="border-neutral-800">
      {relevant.length === 0 && <p className="text-xs text-neutral-600">Belum ada pesanan dibayar.</p>}
      {relevant.map((v) => (
        <div key={v.id} className="rounded border border-neutral-800 bg-neutral-950/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">{v.product?.emoji ?? "📦"}</span>
              <div>
                <div className="text-xs text-neutral-100">{v.product?.name ?? "Pesanan"}</div>
                <div className="text-[10px] text-neutral-500">dijamin {fmtEUR(v.priceEURMinor)} EURC</div>
              </div>
            </div>
            <Badge v={v} busy={busy(v.id)} />
          </div>
          {v.status === "paid" && (
            <div className="mt-2 flex gap-1.5">
              <input value={resi[v.id] ?? "JNE-001"} onChange={(e) => setResi((s) => ({ ...s, [v.id]: e.target.value }))}
                className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] text-neutral-100" />
              <button disabled={busy(v.id)} onClick={() => run(v.id, () => mpShip(v.id, resi[v.id] ?? "JNE-001"))}
                className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-500/20 disabled:opacity-40">Tandai dikirim</button>
            </div>
          )}
          {v.status === "completed" && <p className="mt-1 text-[10px] text-emerald-300/80">Dibayar {fmtEUR(v.eurcOutMinor)} EURC · payout MOCK.</p>}
          {["shipped", "confirmed"].includes(v.status) && <p className="mt-1 text-[10px] text-neutral-500">Menunggu konfirmasi / settlement.</p>}
          {v.status.startsWith("refund") && <p className="mt-1 text-[10px] text-neutral-400">Dikembalikan ke buyer.</p>}
          <TxList view={v} />
        </div>
      ))}
    </Panel>
  );
}
