"use client";

import { useEffect, useState, useTransition } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import {
  CheckCircle2, ExternalLink, Landmark, PenLine, ShoppingCart, Store, Truck, Wallet, X,
} from "lucide-react";
import { CATALOG, fmtEUR } from "../lib/catalog";
import {
  mpCheckout, mpPay, mpConfirm, mpDispute, mpShip, mpRelease, mpRefund, mpListOrders, mpBalances,
  mpAddrArcUsdc, mpAuthTypedData, mpPaySigned, mpDemoBuyer,
  mpAddrSepUsdc, mpOrderAmount, mpMarkFunding, mpRecordWalletFunding, mpRelay, mpAddrEurc,
  type OrderView, type PaySource, type Balances, type RelayView,
} from "./marketplace.actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
// App Kit is ~370 kB in the browser and only the connected-wallet path needs it,
// so the rails module is pulled in on demand rather than at first paint.
import type { Eip1193 } from "./wallet-rails";
const rails = () => import("./wallet-rails");
import SellerCashout from "./SellerCashout";
import MintRedeem from "./MintRedeem";
import { Empty, Metric, Panel, SectionLabel, StatusBadge, num, shortAddr, shortHash, usd } from "./_ui";

const txUrl = (chain: string | null, h: string) =>
  chain === "Ethereum_Sepolia" ? `https://sepolia.etherscan.io/tx/${h}` : `https://testnet.arcscan.app/tx/${h}`;

const STAGES = ["Paid", "Shipped", "Received", "Done"];
const STAGE_OF: Record<string, number> = {
  waiting_payment: -1, processing_payment: -1,
  paid: 0, shipped: 1, confirmed: 2, settling: 2, completed: 3,
  dispute: 1, refunding: 1, refunded: 1,
};

// Payment rails and the balance each draws from, vs the order's usdcAmount.
const RAILS: Array<{ id: PaySource; label: string; bal: (b: Balances) => number; fee?: number; note: string }> = [
  { id: "arc", label: "USDC on Arc", bal: (b) => num(b.buyerArcUsdc), note: "direct, fastest" },
  { id: "unified", label: "Unified Balance", bal: (b) => num(b.buyerGatewayUsdc), fee: 1, note: "Gateway spend → Arc" },
  { id: "bridge", label: "Sepolia bridge", bal: (b) => num(b.buyerSepUsdc), note: "CCTP ~44s" },
];

/* ── order primitives ─────────────────────────────────────────────────────── */

function Tracker({ status }: { status: string }) {
  const cur = STAGE_OF[status] ?? -1;
  const branched = status === "dispute" || status.startsWith("refund");
  return (
    <div className="flex items-center gap-1">
      {STAGES.map((s, i) => (
        <div key={s} className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn("h-1 rounded-full", i <= cur ? "bg-emerald-500" : "bg-border")} />
          <span className={cn("truncate text-[10px]", i <= cur ? "text-foreground" : "text-muted-foreground")}>{s}</span>
        </div>
      ))}
      {branched && <span className="ml-1 shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">disputed</span>}
    </div>
  );
}

function TxList({ view }: { view: OrderView }) {
  if (!view.payments.length) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t pt-2">
      {view.payments.map((p, i) => (
        <li key={i} className="flex items-baseline gap-1.5 text-[11px]">
          <span className="font-mono text-muted-foreground">{p.kind}</span>
          {p.txHash && p.txHash.length > 20 ? (
            <a href={txUrl(p.chain, p.txHash)} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 font-mono text-sky-600 hover:underline">
              {shortHash(p.txHash)}
              <ExternalLink className="size-2.5" />
            </a>
          ) : (
            <span className="text-muted-foreground/70">{p.status}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Card wrapper shared by every order row across the panels. */
function OrderCard({ v, busy, sub, children }: {
  v: OrderView; busy: boolean; sub?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-xs">
      <div className="flex items-start gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-lg">
          {v.product?.emoji ?? "📦"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{v.product?.name ?? "Order"}</div>
          <div className="truncate text-xs text-muted-foreground">{sub}</div>
        </div>
        <StatusBadge status={v.status} label={v.statusLabel} busy={busy} />
      </div>
      {children}
    </div>
  );
}

/* ── board ────────────────────────────────────────────────────────────────── */

export default function Marketplace() {
  const [views, setViews] = useState<OrderView[]>([]);
  const [bal, setBal] = useState<Balances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const { address, isConnected, addresses } = useAccount();
  const [walletUsdc, setWalletUsdc] = useState<string | null>(null);
  const [demoBuyer, setDemoBuyer] = useState<string | null>(null);

  // Two-wallet mode: buyer and seller are different addresses the user actually
  // controls. The seller only RECEIVES, so it needs no signature — which is why
  // a second account from the same wallet is enough to play the part honestly.
  const [sellerWallet, setSellerWallet] = useState<string | null>(null);
  useEffect(() => { setSellerWallet(localStorage.getItem("rivo.sellerWallet")); }, []);
  const pickSeller = (a: string | null) => {
    setSellerWallet(a);
    if (a) localStorage.setItem("rivo.sellerWallet", a);
    else localStorage.removeItem("rivo.sellerWallet");
  };
  const sellerCandidates = (addresses ?? []).filter((a) => a.toLowerCase() !== address?.toLowerCase());
  // With a buyer wallet connected, a purchase needs a seller wallet too —
  // otherwise the "two parties" the demo is meant to show collapse into one.
  const needsSeller = isConnected && !sellerWallet;
  useEffect(() => { mpDemoBuyer().then(setDemoBuyer); }, []);
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
    start(async () => { setBusyId(id); const r = await fn(); if (!r.ok && "error" in r) setError(r.error ?? "failed"); await refresh(); setBusyId(null); });
  const busy = (id: string) => pending && busyId === id;

  return (
    <>
      <div className="flex min-h-0 flex-col gap-3 xl:h-full">
        <Storefront pending={pending} blocked={needsSeller}
          onBuy={(id) => run(null, () => mpCheckout(id, isConnected ? address : undefined, sellerWallet ?? undefined))} />

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <BuyerPanel views={views} bal={bal} pending={pending} busy={busy} run={run}
            connectedAddress={isConnected ? address ?? null : null} walletUsdc={walletUsdc}
            demoBuyer={demoBuyer} />
          <SellerPanel views={views} busy={busy} run={run} buyerConnected={isConnected}
            sellerWallet={sellerWallet} candidates={sellerCandidates} onPick={pickSeller} />
          <HostPanel views={views} busy={busy} run={run} />
          <SellerWalletPanel bal={bal} sellerWallet={sellerWallet} />
        </div>
      </div>

      {error && (
        <div className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[90vw] items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 shadow-lg">
          <span className="truncate">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss" className="text-red-500 hover:text-red-800">
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </>
  );
}

type RunFn = (id: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) => void;

/* ── storefront strip ─────────────────────────────────────────────────────── */

/**
 * The catalog sits above the role columns, not inside Buyer: it is the entry
 * point of the whole demo and keeps the four columns evenly tall.
 */
function Storefront({ pending, blocked, onBuy }: {
  pending: boolean; blocked: boolean; onBuy: (productId: string) => void;
}) {
  return (
    <Card className="shrink-0 gap-0 px-3 py-2.5 shadow-xs">
      <div className="flex items-center gap-3">
        <div className="flex shrink-0 items-center gap-2 pr-1">
          <ShoppingCart className="size-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Storefront</span>
        </div>
        {blocked && (
          <p className="shrink-0 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            Pick a seller wallet first (Seller panel) — a purchase needs two distinct parties.
          </p>
        )}
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          {CATALOG.map((p) => (
            <div key={p.id}
              className="flex items-center gap-2 rounded-lg border bg-card px-2 py-1.5 transition-colors hover:bg-accent/40">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-base">{p.emoji}</span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-xs font-medium">{p.name}</div>
                <div className="text-xs font-semibold tabular-nums text-emerald-600">{fmtEUR(p.priceEURMinor)}</div>
              </div>
              <Button size="xs" variant="outline" disabled={pending || blocked} onClick={() => onBuy(p.id)}>Buy</Button>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/* ── 1. Buyer — storefront + own orders ───────────────────────────────────── */

function BuyerPanel({ views, bal, pending, busy, run, connectedAddress, walletUsdc, demoBuyer }: {
  views: OrderView[]; bal: Balances | null; pending: boolean; busy: (id: string) => boolean; run: RunFn;
  connectedAddress: string | null; walletUsdc: string | null; demoBuyer: string | null;
}) {
  const [rail, setRail] = useState<Record<string, PaySource>>({});
  const [disputeFor, setDisputeFor] = useState<string | null>(null);
  const [reason, setReason] = useState("Item not as described");
  const [showDemo, setShowDemo] = useState(false);
  const { signTypedDataAsync } = useSignTypedData();
  const { connector } = useAccount();

  // The connected wallet's own funding sources, read the same way the demo
  // buyer's are — Arc from the server, Sepolia from the server, Gateway from the
  // wallet itself (the balance is keyed to the depositor, so only it can ask).
  const [gwUsdc, setGwUsdc] = useState<string | null>(null);
  const [sepUsdc, setSepUsdc] = useState<string | null>(null);
  const [railBusy, setRailBusy] = useState<string | null>(null);

  const getProvider = async (): Promise<Eip1193 | null> =>
    ((await connector?.getProvider?.()) as Eip1193 | undefined) ?? null;

  const loadWalletRails = async (address: string) => {
    mpAddrSepUsdc(address).then(setSepUsdc);
    try {
      const provider = await getProvider();
      if (!provider) return;
      setGwUsdc((await (await rails()).walletGatewayBalance(provider)).confirmedMinor);
    } catch {
      setGwUsdc(null); // Gateway unreachable or wallet on an unsupported chain
    }
  };

  useEffect(() => {
    if (!connectedAddress) { rails().then((m) => m.resetWalletRails()); setGwUsdc(null); setSepUsdc(null); return; }
    loadWalletRails(connectedAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedAddress, connector]);

  const same = (a: string, b: string | null) => b != null && a.toLowerCase() === b.toLowerCase();
  // Who can actually sign for this order: the connected wallet, or the demo
  // buyer whose key the server holds. Anything else can only be watched.
  const isMine = (v: OrderView) => same(v.payer, connectedAddress);
  const isDemo = (v: OrderView) => same(v.payer, demoBuyer);

  // With a wallet connected the demo buyer is someone else's account — keep it
  // out of the way unless explicitly asked for.
  const demoOrders = connectedAddress ? views.filter((v) => !isMine(v)) : [];
  const shown = connectedAddress && !showDemo ? views.filter(isMine) : views;

  // The same three rails the demo buyer has, drawn from THIS wallet's balances.
  const MY_RAILS: Array<{ id: PaySource; label: string; avail: number; fee?: number; note: string }> = [
    { id: "arc", label: "USDC on Arc", avail: num(walletUsdc), note: "direct, no gas" },
    { id: "unified", label: "Unified Balance", avail: num(gwUsdc), fee: 1, note: "Gateway spend → Arc, sub-second" },
    { id: "bridge", label: "Sepolia bridge", avail: num(sepUsdc), note: "CCTP ~44s · needs Sepolia ETH" },
  ];
  const railEnough = (id: PaySource, need: number) => {
    const r = MY_RAILS.find((x) => x.id === id);
    return r != null && r.avail >= need + (r.fee ?? 0);
  };

  // Connected-wallet pay: fetch the ERC-3009 typed data, sign it in the browser
  // wallet, and hand the signature back for the operator to relay (gasless).
  const signAndAuthorize = async (v: OrderView): Promise<{ ok: boolean; error?: string }> => {
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
      return { ok: false, error: "Signature rejected in wallet" };
    }
    return mpPaySigned(v.id, signature);
  };

  /**
   * Pay one of my own orders. Same three rails the demo buyer has, only every
   * leg is signed by this wallet: bring the USDC to my address on Arc, then sign
   * the ERC-3009 so the operator can pull it into escrow (gasless).
   */
  const payFromWallet = (v: OrderView, source: PaySource) =>
    run(v.id, async () => {
      if (source !== "arc") {
        const provider = await getProvider();
        if (!provider || !connectedAddress) return { ok: false, error: "Wallet provider unavailable" };
        const amt = await mpOrderAmount(v.id);
        if (!amt) return { ok: false, error: "order amount not found" };
        await mpMarkFunding(v.id);
        try {
          const txHash = source === "unified"
            ? await (await rails()).walletSpendToArc(provider, { amountMinor: BigInt(amt), recipient: connectedAddress })
            : await (await rails()).walletBridgeToArc(provider, BigInt(amt));
          await mpRecordWalletFunding(v.id, source === "unified" ? "gw-spend" : "bridge", txHash);
        } catch (e) {
          return { ok: false, error: `${source === "unified" ? "Gateway spend" : "Bridge"} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
        }
        if (connectedAddress) await loadWalletRails(connectedAddress);
      }
      return signAndAuthorize(v);
    });

  /** Top up the wallet's Gateway balance from Sepolia so the unified rail is usable. */
  const depositToGateway = async (amountMinor: bigint) => {
    const provider = await getProvider();
    if (!provider || !connectedAddress) return;
    setRailBusy("deposit");
    try {
      await (await rails()).walletGatewayDeposit(provider, amountMinor);
      await loadWalletRails(connectedAddress);
    } catch {
      /* surfaced by the balance staying put — Gateway credits only after finality */
    }
    setRailBusy(null);
  };

  return (
    <Panel title="Buyer" hint="Shop and pay in USDC from any chain" icon={<ShoppingCart className="size-4" />}>
      {/* Two distinct accounts, deliberately: the connected browser wallet pays for
          its own orders, the server-signed demo buyer pays for the rest. */}
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        {connectedAddress && (
          <div className="rounded-md border bg-card px-2.5 py-2">
            <div className="flex items-center gap-2">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                My wallet · USDC
              </div>
              <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
                {shortAddr(connectedAddress)}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Metric label="Arc" value={usd(walletUsdc)} />
              <Metric label="Sepolia" value={usd(sepUsdc)} />
              <Metric label="Gateway" value={usd(gwUsdc)} />
            </div>
          </div>
        )}
        {(!connectedAddress || showDemo) && (
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Demo buyer · server-signed (USDC)
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Metric label="Arc" value={usd(bal?.buyerArcUsdc)} />
              <Metric label="Sepolia" value={usd(bal?.buyerSepUsdc)} />
              <Metric label="Gateway" value={usd(bal?.buyerGatewayUsdc)} />
            </div>
            {connectedAddress && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                A separate account from your wallet — it only pays for orders created with no wallet connected.
              </p>
            )}
          </div>
        )}
      </div>

      {connectedAddress && (
        <p className="rounded-md border border-sky-200 bg-sky-50 px-2.5 py-2 text-xs text-sky-700">
          You are the <span className="font-medium">payer</span>: new orders use your address, and all three rails
          (Arc · Gateway · Sepolia bridge) run from your own wallet. The escrow authorization stays gasless — the
          operator pays that gas.
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">My orders</span>
        {shown.length > 0 && (
          <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {shown.length}
          </span>
        )}
        <span className="h-px flex-1 bg-border" />
        {connectedAddress && demoOrders.length > 0 && (
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setShowDemo((s) => !s)}>
            {showDemo ? "Hide demo orders" : `Show demo orders (${demoOrders.length})`}
          </Button>
        )}
      </div>
      {shown.length === 0 && (
        <Empty>
          {connectedAddress
            ? "No orders from this wallet yet — pick something from the storefront."
            : "No orders yet — pick something from the storefront."}
        </Empty>
      )}
      {shown.map((v) => {
        const need = num(v.usdcAmount);
        const sel = rail[v.id] ?? "arc";
        const mine = isMine(v);
        const payableByServer = isDemo(v);
        return (
          <OrderCard key={v.id} v={v} busy={busy(v.id)}
            sub={`${fmtEUR(v.priceEURMinor)} · pay ${usd(v.usdcAmount)} USDC`}>
            <div className="mt-3"><Tracker status={v.status} /></div>

            {v.status === "waiting_payment" && mine && (
              <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-sky-700">
                  <PenLine className="size-3.5" />Pay from my wallet · needs {usd(v.usdcAmount)} USDC on Arc
                </div>
                <div className="mt-2 flex flex-col gap-1.5">
                  {MY_RAILS.map((r) => {
                    const avail = r.avail;
                    const enough = avail >= need + (r.fee ?? 0);
                    const active = sel === r.id;
                    return (
                      <button key={r.id} disabled={pending} onClick={() => setRail((s) => ({ ...s, [v.id]: r.id }))}
                        className={cn(
                          "flex items-start gap-2 rounded-md border bg-card px-2.5 py-2 text-left text-xs transition disabled:opacity-40",
                          active ? "border-primary ring-1 ring-primary/20" : "hover:bg-accent/60",
                        )}>
                        <span className={cn("mt-1 size-2 shrink-0 rounded-full", active ? "bg-primary" : "bg-border")} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{r.label}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">{r.note}</span>
                        </span>
                        <span className={cn("shrink-0 tabular-nums", enough ? "text-foreground" : "text-red-500")}>
                          {avail.toFixed(2)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Gateway is empty but Sepolia isn't — offer the deposit that makes the rail usable. */}
                {num(gwUsdc) < need && num(sepUsdc) >= need && (
                  <Button size="xs" variant="outline" className="mt-2 w-full" disabled={railBusy !== null || pending}
                    onClick={() => depositToGateway(BigInt(v.usdcAmount ?? "0"))}>
                    {railBusy === "deposit"
                      ? "Depositing into Gateway…"
                      : `Deposit ${usd(v.usdcAmount)} USDC into Gateway (from Sepolia)`}
                  </Button>
                )}

                <Button size="sm" className="mt-2 w-full" disabled={pending || !railEnough(sel, need)}
                  onClick={() => payFromWallet(v, sel)}>
                  {railEnough(sel, need)
                    ? `Pay via ${MY_RAILS.find((r) => r.id === sel)?.label}`
                    : `Not enough ${MY_RAILS.find((r) => r.id === sel)?.label}`}
                </Button>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {sel === "arc"
                    ? "One ERC-3009 signature — no gas."
                    : sel === "unified"
                      ? "Gateway spend to Arc (sub-second), then the ERC-3009 signature."
                      : "CCTP bridge ~44s: approve + burn on Sepolia (needs Sepolia ETH for gas), then the ERC-3009 signature."}
                </p>
              </div>
            )}

            {v.status === "waiting_payment" && !mine && !payableByServer && (
              <p className="mt-3 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                This order belongs to <span className="font-mono text-foreground">{shortAddr(v.payer)}</span> — only that
                wallet can sign its ERC-3009. Connect it to pay.
              </p>
            )}

            {v.status === "waiting_payment" && !mine && payableByServer && (
              <div className="mt-3 rounded-md border bg-muted/40 p-3">
                <div className="text-xs font-medium text-muted-foreground">Pay with USDC from (demo buyer)</div>
                <div className="mt-2 flex flex-col gap-1.5">
                  {RAILS.map((r) => {
                    const avail = bal ? r.bal(bal) : 0;
                    const enough = avail >= need + (r.fee ?? 0);
                    const active = sel === r.id && enough;
                    return (
                      <button key={r.id} disabled={!enough || pending} onClick={() => setRail((s) => ({ ...s, [v.id]: r.id }))}
                        className={cn(
                          "flex items-start gap-2 rounded-md border bg-card px-2.5 py-2 text-left text-xs transition disabled:opacity-40",
                          active ? "border-primary ring-1 ring-primary/20" : "hover:bg-accent/60",
                        )}>
                        <span className={cn("mt-1 size-2 shrink-0 rounded-full", active ? "bg-primary" : "bg-border")} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{r.label}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">{r.note}</span>
                        </span>
                        <span className={cn("shrink-0 tabular-nums", enough ? "text-foreground" : "text-red-500")}>
                          {avail.toFixed(2)}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <Button size="sm" className="mt-2 w-full" disabled={pending} onClick={() => run(v.id, () => mpPay(v.id, sel))}>
                  Pay via {RAILS.find((r) => r.id === sel)?.label} (gasless)
                </Button>
              </div>
            )}

            {v.shippedResi && (
              <p className="mt-2 text-xs text-muted-foreground">
                Tracking <span className="font-mono text-foreground">{v.shippedResi}</span>
              </p>
            )}
            {v.disputeReason && <p className="mt-2 text-xs text-red-600">Dispute: {v.disputeReason}</p>}
            {v.status === "completed" && <p className="mt-2 text-xs text-emerald-600">Order complete.</p>}

            {(v.status === "shipped" || ["paid", "confirmed"].includes(v.status)) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {v.status === "shipped" && (
                  <Button size="xs" variant="outline" disabled={pending} onClick={() => run(v.id, () => mpConfirm(v.id))}>
                    <CheckCircle2 className="size-3.5" />Order received
                  </Button>
                )}
                <Button size="xs" variant="outline" disabled={pending}
                  onClick={() => setDisputeFor(disputeFor === v.id ? null : v.id)}
                  className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700">
                  Raise dispute
                </Button>
              </div>
            )}
            {disputeFor === v.id && (
              <div className="mt-2 flex gap-2 rounded-md border border-red-200 bg-red-50 p-2">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 flex-1 text-xs" />
                <Button size="sm" variant="destructive" disabled={pending}
                  onClick={() => { run(v.id, () => mpDispute(v.id, reason)); setDisputeFor(null); }}>
                  Send
                </Button>
              </div>
            )}
            <TxList view={v} />
          </OrderCard>
        );
      })}
    </Panel>
  );
}

/* ── 2. Seller — fulfilment ───────────────────────────────────────────────── */

function SellerPanel({ views, busy, run, buyerConnected, sellerWallet, candidates, onPick }: {
  views: OrderView[]; busy: (id: string) => boolean; run: RunFn;
  buyerConnected: boolean; sellerWallet: string | null; candidates: readonly string[];
  onPick: (a: string | null) => void;
}) {
  const [resi, setResi] = useState<Record<string, string>>({});
  const relevant = views.filter((v) => v.state !== "created");
  return (
    <Panel title="Seller" hint="Incoming orders — guaranteed floored EURC on Arc" icon={<Store className="size-4" />}>
      {buyerConnected && (
        <div className={cn("rounded-lg border p-3", sellerWallet ? "bg-muted/30" : "border-amber-200 bg-amber-50")}>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Seller wallet</div>
          {sellerWallet ? (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="truncate font-mono text-xs text-foreground">{shortAddr(sellerWallet)}</span>
              <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => onPick(null)}>
                Change
              </Button>
            </div>
          ) : candidates.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {candidates.map((a) => (
                <button key={a} onClick={() => onPick(a)}
                  className="rounded-md border bg-card px-2.5 py-1.5 text-left font-mono text-xs hover:bg-accent/60">
                  {shortAddr(a)}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-amber-800">
              Your wallet only permits one address so far. Open MetaMask → Connected sites → permit a second
              address and it will appear here as a seller candidate.
            </p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            The seller only <span className="font-medium">receives</span>, so no signature is needed. Settlement EURC
            is forwarded to this address after the floored swap.
          </p>
        </div>
      )}
      {relevant.length === 0 && <Empty>No paid orders yet.</Empty>}
      {relevant.map((v) => (
        <OrderCard key={v.id} v={v} busy={busy(v.id)} sub={`guaranteed ${fmtEUR(v.priceEURMinor)} EURC`}>
          {v.status === "paid" && (
            <div className="mt-3 flex gap-2">
              <Input value={resi[v.id] ?? "TRK-001"} onChange={(e) => setResi((s) => ({ ...s, [v.id]: e.target.value }))}
                className="h-8 w-32 text-xs" aria-label="Tracking number" />
              <Button size="sm" variant="outline" disabled={busy(v.id)}
                onClick={() => run(v.id, () => mpShip(v.id, resi[v.id] ?? "TRK-001"))}
                className="border-sky-200 text-sky-700 hover:bg-sky-50">
                <Truck className="size-3.5" />Mark as shipped
              </Button>
            </div>
          )}
          {v.status === "completed" && (
            <p className="mt-2 text-xs text-emerald-600">
              {v.sellerAddress
                ? `${fmtEUR(v.priceEURMinor)} EURC forwarded to ${shortAddr(v.sellerAddress)}.`
                : v.eurcOutMinor ? `Received ${fmtEUR(v.eurcOutMinor)} EURC on Arc.` : "EURC received on Arc."}
            </p>
          )}
          {["shipped", "confirmed"].includes(v.status) && (
            <p className="mt-2 text-xs text-muted-foreground">Waiting on buyer confirmation / settlement.</p>
          )}
          {v.status.startsWith("refund") && <p className="mt-2 text-xs text-muted-foreground">Refunded to the buyer.</p>}
          <TxList view={v} />
        </OrderCard>
      ))}
    </Panel>
  );
}

/* ── 3. Host — the authority ──────────────────────────────────────────────── */

function HostPanel({ views, busy, run }: { views: OrderView[]; busy: (id: string) => boolean; run: RunFn }) {
  const active = views.filter((v) => v.state !== "created");
  const settleable = active.filter((v) => (v.status === "confirmed" || v.status === "shipped") && !v.disputeReason);
  const disputes = active.filter((v) => v.status === "dispute");

  // The relay is the host's running cost: the operator pays Arc gas (USDC) for
  // every escrow call, and the fee is what refills it.
  const [relay, setRelay] = useState<RelayView | null>(null);
  useEffect(() => {
    mpRelay().then(setRelay);
    const id = setInterval(() => mpRelay().then(setRelay), 30_000);
    return () => clearInterval(id);
  }, []);
  const gasLow = relay?.gasUsdc != null && Number(relay.gasUsdc) < Number(relay.minGasUsdc);

  return (
    <Panel title="Host / Marketplace" hint="Only the host releases & refunds · 5% commission, illustrative"
      icon={<Landmark className="size-4" />}>
      <div className={cn("rounded-lg border p-3", gasLow ? "border-red-200 bg-red-50" : "bg-muted/30")}>
        <div className="flex items-start gap-3">
          <Metric label="Operator gas (Arc)" value={relay?.gasUsdc == null ? "—" : `${relay.gasUsdc} USDC`}
            tone={gasLow ? "default" : "positive"} />
          <Metric label="Operator fee" value={relay ? `${(relay.feeBps / 100).toFixed(2)}%` : "—"} className="text-right" />
        </div>
        <p className={cn("mt-2 text-[11px]", gasLow ? "text-red-700" : "text-muted-foreground")}>
          {gasLow
            ? `Below the ${relay?.minGasUsdc} USDC floor — new orders are REFUSED until the operator is topped up, so no buyer is stranded mid-flow.`
            : relay?.feeBps
              ? `The operator pays for the gasless relay; the fee is added on top of the price (never taken out of the seller floor) and withheld by the escrow at capture. Stop floor: ${relay?.minGasUsdc} USDC.`
              : "Fee 0 — the operator subsidises all gas. Set RIVO_FEE_BPS to recover the cost."}
        </p>
      </div>

      {disputes.length > 0 && (
        <>
          <SectionLabel count={disputes.length}>Disputes</SectionLabel>
          {disputes.map((v) => (
            <div key={v.id} className="rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="text-sm font-medium">
                {v.product?.emoji} {v.product?.name} · {fmtEUR(v.priceEURMinor)}
              </div>
              <p className="mt-1 text-xs text-red-600">{v.disputeReason}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="xs" variant="destructive" disabled={busy(v.id)} onClick={() => run(v.id, () => mpRefund(v.id))}>
                  {busy(v.id) ? "…" : "Approve refund"}
                </Button>
                <Button size="xs" variant="outline" disabled={busy(v.id)} onClick={() => run(v.id, () => mpRelease(v.id))}
                  className="border-emerald-200 text-emerald-700 hover:bg-emerald-50">
                  Release to seller
                </Button>
              </div>
            </div>
          ))}
        </>
      )}

      <SectionLabel count={settleable.length}>Ready to settle</SectionLabel>
      {settleable.length === 0 && <Empty>No orders waiting on settlement.</Empty>}
      {settleable.map((v) => {
        const price = num(v.priceEURMinor);
        return (
          <OrderCard key={v.id} v={v} busy={busy(v.id)}
            sub={`${fmtEUR(v.priceEURMinor)} − commission €${(price * 0.05).toFixed(2)} → €${(price * 0.95).toFixed(2)} · ${v.buyerConfirmed ? "buyer ✓" : "auto"}`}>
            <Button size="sm" className="mt-3 w-full" disabled={busy(v.id)} onClick={() => run(v.id, () => mpRelease(v.id))}>
              {busy(v.id) ? "Settling…" : "Release & settle → seller"}
            </Button>
          </OrderCard>
        );
      })}

      <SectionLabel count={active.length}>All orders</SectionLabel>
      {active.length === 0 && <Empty>No activity yet.</Empty>}
      <div className="space-y-1.5">
        {active.map((v) => (
          <div key={v.id} className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-xs">
            <span className="truncate">{v.product?.emoji} {v.product?.name ?? v.id.slice(0, 12)}</span>
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{fmtEUR(v.priceEURMinor)}</span>
            <StatusBadge status={v.status} label={v.statusLabel} busy={busy(v.id)} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ── 4. Seller wallet — fiat exits ────────────────────────────────────────── */

function SellerWalletPanel({ bal, sellerWallet }: { bal: Balances | null; sellerWallet: string | null }) {
  const [ownEurc, setOwnEurc] = useState<string | null>(null);
  useEffect(() => {
    if (!sellerWallet) { setOwnEurc(null); return; }
    const read = () => mpAddrEurc(sellerWallet).then(setOwnEurc);
    read();
    const id = setInterval(read, 15_000);
    return () => clearInterval(id);
  }, [sellerWallet]);

  return (
    <Panel title="Wallet Seller" hint="Balances on Arc and the exits to a bank account" icon={<Wallet className="size-4" />}>
      <Card className="gap-0 p-3 shadow-xs">
        {sellerWallet ? (
          <>
            <div className="flex items-start gap-3">
              <Metric label="EURC · seller wallet" value={`€${usd(ownEurc)}`} tone="positive" />
              <Metric label="Wallet" value={<span className="font-mono text-xs">{shortAddr(sellerWallet)}</span>}
                className="text-right" />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The settlement wallet (€{usd(bal?.sellerEurc)}) runs the floored swap and forwards the floor here — so
              it is a <span className="font-medium text-foreground">hop</span>, not the destination.
            </p>
          </>
        ) : (
          <>
            <Metric label="EURC on Arc" value={`€${usd(bal?.sellerEurc)}`} tone="positive" />
            <p className="mt-1 text-xs text-muted-foreground">
              Proceeds of the floored settlement. Two exits: CPN (USDC→local fiat) or Circle Mint (1:1 bank redemption).
            </p>
          </>
        )}
      </Card>
      {sellerWallet && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
          The cash-out below still uses the demo seller wallet (server key) — the Permit2 approve and CPN submit have
          not moved to browser signing, so it does not yet cash out the seller wallet balance above.
        </p>
      )}
      <SellerCashout />
      <MintRedeem />
    </Panel>
  );
}
