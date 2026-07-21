"use client";

import { useEffect, useState, useTransition } from "react";
import {
  createOrderAction, fundAction, releaseAction, refundAction, snapshotAction,
  type ActionResult, type Snapshot,
} from "./actions";

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
  created: "border-neutral-600 text-neutral-300",
  funding_pending: "border-sky-500/40 text-sky-300",
  funded: "border-emerald-500/40 text-emerald-300",
  settlement_pending: "border-amber-500/40 text-amber-300",
  released: "border-emerald-500/40 text-emerald-300",
  refund_pending: "border-sky-500/40 text-sky-300",
  refunded: "border-neutral-500 text-neutral-300",
  failed: "border-red-500/40 text-red-300",
};

function Btn({ onClick, disabled, children, kind = "default" }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode; kind?: "default" | "primary" | "danger";
}) {
  const tone =
    kind === "primary" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
    : kind === "danger" ? "border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20"
    : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {children}
    </button>
  );
}

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
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          Demo interaktif — jalankan alur lewat SDK
        </h2>
        {state && (
          <span className={`rounded border px-2 py-0.5 font-mono text-xs ${STATE_TONE[state] ?? "border-neutral-600 text-neutral-300"}`}>
            {pending ? "…memproses" : state}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        Testnet. Buyer ditandatangani server pakai kunci demo (di produksi buyer tandatangan di wallet-nya).
        Operasi on-chain butuh 1–2 menit.
      </p>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {/* Buyer */}
        <div className="rounded border border-neutral-800 bg-neutral-950/40 p-4">
          <h3 className="text-sm font-medium text-neutral-200">Buyer</h3>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs text-neutral-400">
              priceEUR
              <input
                value={price} onChange={(e) => setPrice(e.target.value)} disabled={!canCreate || pending}
                className="mt-1 block w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 disabled:opacity-40"
              />
            </label>
            <label className="text-xs text-neutral-400">
              wedge
              <select
                value={wedge} onChange={(e) => setWedge(e.target.value as typeof wedge)} disabled={!canCreate || pending}
                className="mt-1 block rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 disabled:opacity-40"
              >
                {WEDGES.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn kind="primary" disabled={!canCreate || pending}
              onClick={() => run(() => createOrderAction(String(Math.round(parseFloat(price || "0") * 1e6)), wedge))}>
              createOrder
            </Btn>
            <Btn disabled={!canFund || pending} onClick={() => run(() => fundAction(snap!.orderId))}>fund (gasless)</Btn>
            <Btn kind="danger" disabled={!canRefund || pending} onClick={() => run(() => refundAction(snap!.orderId))}>refund</Btn>
          </div>
        </div>

        {/* Seller */}
        <div className="rounded border border-neutral-800 bg-neutral-950/40 p-4">
          <h3 className="text-sm font-medium text-neutral-200">Seller (penerima EURC)</h3>
          <p className="mt-1 text-xs text-neutral-500">
            Lepas dana saat akses diberikan / milestone di-approve. Penerima dijamin ≥ priceEUR atau swap revert.
          </p>
          <div className="mt-3">
            <Btn kind="primary" disabled={!canRelease || pending} onClick={() => run(() => releaseAction(snap!.orderId))}>
              release (capture → swap floor)
            </Btn>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-200">
          {error}
        </div>
      )}

      {/* Inspector */}
      {snap && (
        <div className="mt-5 rounded border border-neutral-800 bg-neutral-950/40 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-neutral-200">Execution Inspector</h3>
            <span className="font-mono text-xs text-neutral-500">{snap.orderId}</span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
            <div><dt className="text-neutral-500">priceEUR</dt><dd className="text-neutral-200">{EUR(snap.priceEUR)}</dd></div>
            <div><dt className="text-neutral-500">usdcAmount</dt><dd className="text-neutral-200">{USDC(snap.usdcAmount)}</dd></div>
            <div><dt className="text-neutral-500">wedge</dt><dd className="font-mono text-neutral-200">{snap.wedge}</dd></div>
            <div><dt className="text-neutral-500">refund ke</dt><dd className="text-neutral-200">{snap.receivingChain}</dd></div>
          </dl>

          {snap.payments.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-neutral-800 pt-3">
              {snap.payments.map((p, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
                  <span className="w-24 shrink-0 font-mono text-emerald-300">{p.kind}</span>
                  <span className="text-neutral-500">{p.status}</span>
                  {p.txHash && p.txHash.startsWith("0x") && p.txHash.length > 20 ? (
                    <a href={txUrl(p.chain, p.txHash)} target="_blank" rel="noopener noreferrer"
                      className="break-all font-mono text-sky-400 hover:underline">
                      {p.txHash.slice(0, 10)}…{p.txHash.slice(-8)}
                    </a>
                  ) : (
                    <span className="text-neutral-600">{p.txHash ?? "—"}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {snap.payout && (
            <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-amber-100">
                  payout {EUR(snap.payout.sourceAmount)} EURC → {EUR(snap.payout.targetAmount)} EUR
                </span>
                <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                  {snap.payout.label}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-amber-200/70">{snap.payout.disclaimer}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
