"use client";

import { useEffect, useState, useTransition } from "react";
import { CATALOG, fmtEUR } from "../lib/catalog";
import {
  mpCheckout, mpPay, mpConfirm, mpDispute, mpShip, mpRelease, mpRefund, mpListOrders,
  type OrderView,
} from "./marketplace.actions";

type Role = "buyer" | "seller" | "host";

const USDC = (m: string | null) => (m == null ? "—" : `${(Number(m) / 1e6).toFixed(4)} USDC`);
const txUrl = (chain: string | null, h: string) =>
  chain === "Ethereum_Sepolia" ? `https://sepolia.etherscan.io/tx/${h}` : `https://testnet.arcscan.app/tx/${h}`;

// The 8 marketplace stages collapsed into a 4-step buyer-facing tracker.
const STAGES = ["Dibayar", "Dikirim", "Diterima", "Selesai"];
const STAGE_OF: Record<string, number> = {
  waiting_payment: -1, processing_payment: -1,
  paid: 0, shipped: 1, confirmed: 2, settling: 2, completed: 3,
  dispute: 1, refunding: 1, refunded: 1,
};

const TONE: Record<string, string> = {
  waiting_payment: "border-neutral-600 text-neutral-300",
  processing_payment: "border-sky-500/40 text-sky-300",
  paid: "border-emerald-500/40 text-emerald-300",
  shipped: "border-sky-500/40 text-sky-300",
  confirmed: "border-amber-500/40 text-amber-300",
  dispute: "border-red-500/40 text-red-300",
  settling: "border-amber-500/40 text-amber-300",
  refunding: "border-sky-500/40 text-sky-300",
  refunded: "border-neutral-500 text-neutral-300",
  completed: "border-emerald-500/40 text-emerald-300",
};

function Money({ eur, usdc }: { eur: string; usdc: string | null }) {
  return (
    <span className="text-neutral-200">
      {fmtEUR(eur)}
      {usdc && <span className="text-neutral-500"> · bayar {USDC(usdc)}</span>}
    </span>
  );
}

function Tracker({ status }: { status: string }) {
  const cur = STAGE_OF[status] ?? -1;
  const branched = status === "dispute" || status.startsWith("refund");
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {STAGES.map((s, i) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={`rounded px-1.5 py-0.5 ${i <= cur ? "bg-emerald-500/15 text-emerald-300" : "bg-neutral-800 text-neutral-500"}`}>
            {i <= cur ? "✓ " : ""}{s}
          </span>
          {i < STAGES.length - 1 && <span className="text-neutral-700">→</span>}
        </span>
      ))}
      {branched && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">sengketa/refund</span>}
    </div>
  );
}

function TxList({ view }: { view: OrderView }) {
  if (!view.payments.length) return null;
  return (
    <ul className="mt-2 space-y-0.5 border-t border-neutral-800 pt-2">
      {view.payments.map((p, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-2 text-[11px]">
          <span className="w-20 shrink-0 font-mono text-emerald-300/80">{p.kind}</span>
          {p.txHash && p.txHash.length > 20 ? (
            <a href={txUrl(p.chain, p.txHash)} target="_blank" rel="noopener noreferrer" className="font-mono text-sky-400 hover:underline">
              {p.txHash.slice(0, 10)}…{p.txHash.slice(-8)}
            </a>
          ) : <span className="text-neutral-600">{p.status}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function Marketplace() {
  const [role, setRole] = useState<Role>("buyer");
  const [views, setViews] = useState<OrderView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const refresh = async () => {
    const r = await mpListOrders();
    if (r.ok) { setViews(r.views); setError(null); } else setError(r.error);
  };

  useEffect(() => { refresh(); }, []);

  // Poll while anything is mid-flight (payment / settlement / refund on-chain).
  useEffect(() => {
    const live = views.some((v) => v.state.endsWith("_pending") || v.status === "processing_payment" || v.status === "refunding");
    if (!live && !pending) return;
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [views, pending]);

  const run = (id: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setBusyId(id);
      const r = await fn();
      if (!r.ok && "error" in r) setError(r.error ?? "gagal");
      await refresh();
      setBusyId(null);
    });

  const busy = (id: string) => pending && busyId === id;

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Marketplace — non-custodial escrow</h2>
        <div className="flex rounded border border-neutral-700 p-0.5 text-xs">
          {(["buyer", "seller", "host"] as Role[]).map((r) => (
            <button key={r} onClick={() => setRole(r)}
              className={`rounded px-3 py-1 capitalize transition ${role === r ? "bg-neutral-100 text-neutral-900" : "text-neutral-300 hover:bg-neutral-800"}`}>
              {r === "host" ? "Host / Marketplace" : r}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        Dana ditahan escrow CPP di Arc — <span className="text-neutral-300">bukan</span> di platform. Buyer & seller memberi
        sinyal; <span className="text-neutral-300">hanya Host</span> yang berwenang release/refund. Operasi on-chain 1–2 menit.
      </p>

      {error && <div className="mt-3 rounded border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-200">{error}</div>}

      {role === "buyer" && <BuyerView views={views} busy={busy} pending={pending} run={run} />}
      {role === "seller" && <SellerView views={views} busy={busy} run={run} />}
      {role === "host" && <HostView views={views} busy={busy} run={run} />}
    </section>
  );
}

// ── Buyer ────────────────────────────────────────────────────────────────

function BuyerView({ views, busy, pending, run }: {
  views: OrderView[]; busy: (id: string) => boolean; pending: boolean;
  run: (id: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const [disputeFor, setDisputeFor] = useState<string | null>(null);
  const [reason, setReason] = useState("Barang tidak sesuai deskripsi");

  return (
    <div className="mt-5 space-y-6">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Etalase</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CATALOG.map((p) => (
            <div key={p.id} className="flex flex-col rounded border border-neutral-800 bg-neutral-950/40 p-3">
              <div className="text-3xl">{p.emoji}</div>
              <div className="mt-2 text-sm font-medium text-neutral-100">{p.name}</div>
              <div className="text-[11px] text-neutral-500">{p.blurb}</div>
              <div className="mt-1 text-[11px] text-neutral-500">oleh {p.seller}</div>
              <div className="mt-2 text-sm font-semibold text-emerald-300">{fmtEUR(p.priceEURMinor)}</div>
              <button
                disabled={pending}
                onClick={() => run(null, () => mpCheckout(p.id))}
                className="mt-3 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-40"
              >
                Beli sekarang
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Pesanan saya</h3>
        {views.length === 0 && <p className="mt-2 text-xs text-neutral-600">Belum ada pesanan — beli sesuatu di atas.</p>}
        <div className="mt-3 space-y-3">
          {views.map((v) => (
            <div key={v.id} className="rounded border border-neutral-800 bg-neutral-950/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{v.product?.emoji ?? "📦"}</span>
                  <div>
                    <div className="text-sm text-neutral-100">{v.product?.name ?? "Pesanan"}</div>
                    <div className="text-[11px] text-neutral-500"><Money eur={v.priceEURMinor} usdc={v.usdcAmount} /></div>
                  </div>
                </div>
                <span className={`rounded border px-2 py-0.5 text-[11px] ${TONE[v.status] ?? "border-neutral-600 text-neutral-300"}`}>
                  {busy(v.id) ? "…memproses" : v.statusLabel}
                </span>
              </div>
              <div className="mt-3"><Tracker status={v.status} /></div>
              {v.shippedResi && <p className="mt-2 text-[11px] text-neutral-500">Resi: <span className="font-mono text-neutral-300">{v.shippedResi}</span> · tracking (mock)</p>}
              {v.disputeReason && <p className="mt-2 text-[11px] text-red-300">Sengketa diajukan: {v.disputeReason}</p>}

              <div className="mt-3 flex flex-wrap gap-2">
                {v.status === "waiting_payment" && (
                  <button disabled={pending} onClick={() => run(v.id, () => mpPay(v.id))}
                    className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">
                    Bayar (USDC, gasless)
                  </button>
                )}
                {v.status === "shipped" && (
                  <button disabled={pending} onClick={() => run(v.id, () => mpConfirm(v.id))}
                    className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">
                    Pesanan diterima
                  </button>
                )}
                {(v.status === "shipped" || v.status === "paid" || v.status === "confirmed") && (
                  <button disabled={pending} onClick={() => setDisputeFor(disputeFor === v.id ? null : v.id)}
                    className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/20 disabled:opacity-40">
                    Ajukan sengketa
                  </button>
                )}
              </div>

              {disputeFor === v.id && (
                <div className="mt-3 flex flex-wrap items-end gap-2 rounded border border-red-500/20 bg-red-500/5 p-3">
                  <label className="text-[11px] text-neutral-400">
                    Alasan
                    <input value={reason} onChange={(e) => setReason(e.target.value)}
                      className="mt-1 block w-64 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100" />
                  </label>
                  <button disabled={pending} onClick={() => { run(v.id, () => mpDispute(v.id, reason)); setDisputeFor(null); }}
                    className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/20 disabled:opacity-40">
                    Kirim ke host
                  </button>
                  <span className="text-[11px] text-neutral-500">Host yang memutuskan — buyer tak me-refund sendiri.</span>
                </div>
              )}

              {v.status === "completed" && <p className="mt-2 text-[11px] text-emerald-300/80">Selesai. Seller menerima EURC di Arc.</p>}
              {v.status === "refunded" && <p className="mt-2 text-[11px] text-neutral-400">Dana dikembalikan ke kamu.</p>}
              <TxList view={v} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Seller ───────────────────────────────────────────────────────────────

function SellerView({ views, busy, run }: {
  views: OrderView[]; busy: (id: string) => boolean;
  run: (id: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const [resi, setResi] = useState("JNE-DEMO-001");
  const relevant = views.filter((v) => v.state !== "created");
  return (
    <div className="mt-5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Pesanan masuk</h3>
      {relevant.length === 0 && <p className="mt-2 text-xs text-neutral-600">Belum ada pesanan dibayar.</p>}
      <div className="mt-3 space-y-3">
        {relevant.map((v) => (
          <div key={v.id} className="rounded border border-neutral-800 bg-neutral-950/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{v.product?.emoji ?? "📦"}</span>
                <div>
                  <div className="text-sm text-neutral-100">{v.product?.name ?? "Pesanan"}</div>
                  <div className="text-[11px] text-neutral-500">dijamin {fmtEUR(v.priceEURMinor)} EURC</div>
                </div>
              </div>
              <span className={`rounded border px-2 py-0.5 text-[11px] ${TONE[v.status] ?? "border-neutral-600 text-neutral-300"}`}>
                {busy(v.id) ? "…" : v.statusLabel}
              </span>
            </div>
            <div className="mt-3">
              {v.status === "paid" && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-[11px] text-neutral-400">
                    No. resi
                    <input value={resi} onChange={(e) => setResi(e.target.value)}
                      className="mt-1 block w-40 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100" />
                  </label>
                  <button disabled={busy(v.id)} onClick={() => run(v.id, () => mpShip(v.id, resi))}
                    className="rounded border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-200 hover:bg-sky-500/20 disabled:opacity-40">
                    Tandai dikirim
                  </button>
                </div>
              )}
              {v.status === "completed" && v.payout && (
                <p className="text-[11px] text-emerald-300/80">
                  Dibayar {fmtEUR(v.eurcOutMinor ?? v.payout.targetAmountMinor)} EURC di Arc. Instruksi payout fiat berlabel MOCK diterbitkan.
                </p>
              )}
              {["shipped", "confirmed"].includes(v.status) && <p className="text-[11px] text-neutral-500">Menunggu konfirmasi pembeli / settlement host.</p>}
              {v.status.startsWith("refund") && <p className="text-[11px] text-neutral-400">Dana dikembalikan ke pembeli.</p>}
            </div>
            <TxList view={v} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Host / Marketplace ─────────────────────────────────────────────────────

function HostView({ views, busy, run }: {
  views: OrderView[]; busy: (id: string) => boolean;
  run: (id: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const active = views.filter((v) => v.state !== "created");
  const settleable = active.filter((v) => (v.status === "confirmed" || v.status === "shipped") && !v.disputeReason);
  const disputes = active.filter((v) => v.status === "dispute");
  return (
    <div className="mt-5 space-y-6">
      <div className="rounded border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-amber-200/80">
        <strong className="text-amber-100">Host = otoritas.</strong> Release melepas escrow ke seller (capture → swap ber-floor);
        refund mengembalikan ke buyer. Komisi 5% di bawah bersifat ilustratif (mesin settlement host) — on-chain saat ini capture penuh.
      </div>

      {disputes.length > 0 && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-red-400">Sengketa — perlu keputusan</h3>
          <div className="mt-3 space-y-3">
            {disputes.map((v) => (
              <div key={v.id} className="rounded border border-red-500/30 bg-red-500/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm text-neutral-100">{v.product?.emoji} {v.product?.name} · {fmtEUR(v.priceEURMinor)}</div>
                  <span className="font-mono text-[11px] text-neutral-500">{v.id}</span>
                </div>
                <p className="mt-1 text-[11px] text-red-300">Alasan buyer: {v.disputeReason}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button disabled={busy(v.id)} onClick={() => run(v.id, () => mpRefund(v.id))}
                    className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/20 disabled:opacity-40">
                    {busy(v.id) ? "…" : "Setujui refund (buyer benar)"}
                  </button>
                  <button disabled={busy(v.id)} onClick={() => run(v.id, () => mpRelease(v.id))}
                    className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">
                    Tolak, lepas ke seller
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Siap di-settle</h3>
        {settleable.length === 0 && <p className="mt-2 text-xs text-neutral-600">Tak ada yang menunggu settlement.</p>}
        <div className="mt-3 space-y-3">
          {settleable.map((v) => {
            const price = Number(v.priceEURMinor) / 1e6;
            return (
              <div key={v.id} className="rounded border border-neutral-800 bg-neutral-950/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm text-neutral-100">{v.product?.emoji} {v.product?.name}</div>
                  <span className={`rounded border px-2 py-0.5 text-[11px] ${TONE[v.status]}`}>{v.statusLabel}</span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-6 text-[11px] text-neutral-400 sm:grid-cols-4">
                  <div><dt className="text-neutral-500">harga</dt><dd>{fmtEUR(v.priceEURMinor)}</dd></div>
                  <div><dt className="text-neutral-500">komisi 5%</dt><dd>-€{(price * 0.05).toFixed(2)}</dd></div>
                  <div><dt className="text-neutral-500">net seller (ilus.)</dt><dd className="text-neutral-200">€{(price * 0.95).toFixed(2)}</dd></div>
                  <div><dt className="text-neutral-500">konfirmasi</dt><dd>{v.buyerConfirmed ? "buyer ✓" : "auto/timeout"}</dd></div>
                </dl>
                <button disabled={busy(v.id)} onClick={() => run(v.id, () => mpRelease(v.id))}
                  className="mt-3 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">
                  {busy(v.id) ? "…settling" : "Rilis & settle → seller"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Semua pesanan</h3>
        <div className="mt-3 space-y-2">
          {active.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-[11px]">
              <span className="text-neutral-300">{v.product?.emoji} {v.product?.name ?? v.id}</span>
              <span className="text-neutral-500">{fmtEUR(v.priceEURMinor)}</span>
              <span className={`rounded border px-2 py-0.5 ${TONE[v.status] ?? "border-neutral-600 text-neutral-300"}`}>{v.statusLabel}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
