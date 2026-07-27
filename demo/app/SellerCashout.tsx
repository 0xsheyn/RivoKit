"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { ArrowRight, Banknote, CircleCheck, Loader2, TriangleAlert, Wallet } from "lucide-react";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { erc20Abi } from "viem";
import {
  cpnBroadcastAction,
  cpnBroadcastSignedAction,
  cpnCorridorsAction,
  cpnIntentAction,
  cpnPrepareAction,
  cpnSellerBalanceAction,
  type BroadcastView,
  type PreparedView,
} from "./ramp.actions";
import { normalizeTypedData, type MessageToBeSigned } from "../../src/ramp/cpn-sign.ts";
import { ARC_TESTNET_CHAIN_ID, PERMIT2_ADDRESS, USDC_ADDRESS } from "../../src/constants/arc.ts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type Corridor = { key: string; label: string; currency: string; method: string; minUsdc: number };

/** Who signs the Permit2 intent that lets CPN pull the USDC. */
type SignMode = "server" | "wallet";

const two = (decimal: string | number) => Number(decimal).toFixed(2);

const STATUS_TONE: Record<string, string> = {
  COMPLETED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FAILED: "border-red-200 bg-red-50 text-red-700",
  CRYPTO_FUNDS_PENDING: "border-sky-200 bg-sky-50 text-sky-700",
  FIAT_PAYMENT_INITIATED: "border-amber-200 bg-amber-50 text-amber-700",
};

/**
 * The seller's multi-currency fiat cash-out, shown in the seller wallet panel. Reads
 * the seller wallet's accumulated USDC and off-ramps it via CPN to the chosen
 * corridor (EUR/SEPA, BRL/PIX, MXN/SPEI, USD/WIRE) — a single USDC→fiat
 * conversion, no EURC hop. Complements the EURC-floor/StableFX path, doesn't
 * replace it.
 *
 * Two signing paths, and the difference is the whole point of the panel:
 *
 *   - `server` — a testnet key the server holds stands in for the seller. This
 *     is the path proven end-to-end to COMPLETED on EUR/SEPA.
 *   - `wallet` — the connected wallet signs its own Permit2 approval and its own
 *     payment intent; no server key participates. This is what production looks
 *     like, because the wallet that HOLDS the USDC is the one authorizing it to
 *     leave. Written and wired; not yet executed on-chain.
 */
export default function SellerCashout() {
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  const [corridorKey, setCorridorKey] = useState<string>("");
  const [balMinor, setBalMinor] = useState<string | null>(null);
  const [walletBalMinor, setWalletBalMinor] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [prepared, setPrepared] = useState<PreparedView | null>(null);
  const [broadcast, setBroadcast] = useState<BroadcastView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "prepare" | "approve" | "sign" | "broadcast">(null);
  const [signMode, setSignMode] = useState<SignMode>("server");
  const [, start] = useTransition();

  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: ARC_TESTNET_CHAIN_ID });

  useEffect(() => {
    cpnCorridorsAction().then((cs) => {
      setCorridors(cs);
      if (cs[0]) setCorridorKey(cs[0].key);
    });
  }, []);

  // A connected wallet is the interesting case, so default to it — but never
  // silently: the mode is visible and switchable.
  useEffect(() => { if (isConnected) setSignMode("wallet"); else setSignMode("server"); }, [isConnected]);

  const loadBalance = useCallback((prefill = false) =>
    cpnSellerBalanceAction().then((r) => {
      if (!r.ok) return;
      setBalMinor(r.seller.usdcMinor);
      if (prefill) setAmount(two(Number(r.seller.usdcMinor) / 1e6));
    }), []);
  useEffect(() => { loadBalance(true); }, [loadBalance]);

  // The connected wallet's own USDC on Arc — what IT can actually cash out.
  useEffect(() => {
    if (!address || !publicClient) { setWalletBalMinor(null); return; }
    publicClient
      .readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] })
      .then((b) => setWalletBalMinor(b.toString()))
      .catch(() => setWalletBalMinor(null));
  }, [address, publicClient, broadcast]);

  const corridor = corridors.find((c) => c.key === corridorKey);
  const minUsdc = corridor?.minUsdc ?? 11;
  const activeBalMinor = signMode === "wallet" ? walletBalMinor : balMinor;
  const balNum = activeBalMinor ? Number(activeBalMinor) / 1e6 : 0;
  const amtNum = Number(amount || "0");
  const enough = amtNum >= minUsdc && amtNum <= balNum;

  const reset = () => { setPrepared(null); setBroadcast(null); setConfirmed(false); setError(null); };
  const pickCorridor = (key: string) => { setCorridorKey(key); reset(); };
  const pickMode = (m: SignMode) => { setSignMode(m); reset(); };

  const prepare = () =>
    start(async () => {
      setBusy("prepare"); setError(null); setBroadcast(null); setConfirmed(false);
      // The sender address is baked into the intent, so it must be decided now:
      // an intent prepared for one address cannot later be signed by another.
      const r = await cpnPrepareAction(amount, corridorKey, signMode === "wallet" ? address : undefined);
      if (r.ok) setPrepared(r.prepared);
      else { setPrepared(null); setError(r.error); }
      setBusy(null);
    });

  /** Server-held key signs and broadcasts — the path proven to COMPLETED. */
  const doBroadcastServer = async (paymentId: string) => {
    setBusy("broadcast");
    const r = await cpnBroadcastAction(paymentId);
    if (r.ok) { setBroadcast(r.result); loadBalance(); } else setError(r.error);
  };

  /**
   * The seller's own wallet approves Permit2, signs the intent, and only then
   * does the server broadcast it. Three separate wallet interactions on purpose
   * — approving a spender and authorizing a payment are different decisions.
   */
  const doBroadcastWallet = async (paymentId: string) => {
    if (!address || !publicClient) { setError("Connect a wallet first."); return; }
    if (chainId !== ARC_TESTNET_CHAIN_ID) {
      await switchChainAsync({ chainId: ARC_TESTNET_CHAIN_ID });
    }

    const got = await cpnIntentAction(paymentId);
    if (!got.ok) { setError(got.error); return; }
    const permitAmount = BigInt(got.intent.permitAmountMinor || "0");

    setBusy("approve");
    const allowance = await publicClient.readContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [address, PERMIT2_ADDRESS],
    });
    if (allowance < permitAmount) {
      // Exactly what this payment needs — not an unlimited approval.
      const hash = await writeContractAsync({
        address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, permitAmount],
        chainId: ARC_TESTNET_CHAIN_ID,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }

    setBusy("sign");
    const t = normalizeTypedData(got.intent.messageToBeSigned as MessageToBeSigned);
    // wagmi's typed-data generics cannot infer over a runtime-shaped object;
    // `normalizeTypedData` is guarded instead by a sign→recover round-trip test.
    const signature = await signTypedDataAsync({
      domain: t.domain,
      types: t.types,
      primaryType: t.primaryType,
      message: t.message,
    } as unknown as Parameters<typeof signTypedDataAsync>[0]);

    setBusy("broadcast");
    const r = await cpnBroadcastSignedAction(paymentId, signature);
    if (r.ok) setBroadcast(r.result); else setError(r.error);
  };

  const doBroadcast = () => {
    if (!prepared) return;
    start(async () => {
      setError(null);
      try {
        if (signMode === "wallet") await doBroadcastWallet(prepared.paymentId);
        else await doBroadcastServer(prepared.paymentId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(null);
    });
  };

  const busyLabel =
    busy === "approve" ? "Approving Permit2…" : busy === "sign" ? "Waiting for signature…" : "Broadcasting…";

  return (
    <div className="rounded-lg border bg-card p-3 shadow-xs">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-emerald-50 text-emerald-600">
          <Banknote className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Cash out to fiat · CPN</div>
          <p className="truncate text-xs text-muted-foreground">Sales proceeds in USDC → local currency in a bank</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          <b className="tabular-nums text-foreground">{activeBalMinor ? two(balNum) : "…"}</b> USDC
        </span>
      </div>

      {/* Who signs. The distinction is the point, so it is never implicit. */}
      <div className="mt-3 flex items-center gap-1.5 text-xs">
        <button onClick={() => pickMode("server")}
          className={cn("rounded-md border px-2.5 py-1 font-medium transition",
            signMode === "server" ? "border-primary bg-accent text-foreground ring-1 ring-primary/20" : "bg-card text-muted-foreground hover:bg-accent")}>
          Demo key
        </button>
        <button onClick={() => pickMode("wallet")} disabled={!isConnected}
          className={cn("flex items-center gap-1 rounded-md border px-2.5 py-1 font-medium transition disabled:opacity-40",
            signMode === "wallet" ? "border-primary bg-accent text-foreground ring-1 ring-primary/20" : "bg-card text-muted-foreground hover:bg-accent")}>
          <Wallet className="size-3" /> My wallet
        </button>
        <span className="ml-auto truncate text-[10px] text-muted-foreground">
          {signMode === "wallet"
            ? "the wallet holding the USDC signs — no server key"
            : "a server-held testnet key stands in for the seller"}
        </span>
      </div>

      {/* Corridor selector */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {corridors.map((c) => (
          <button key={c.key} onClick={() => pickCorridor(c.key)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition",
              c.key === corridorKey
                ? "border-primary bg-accent text-foreground ring-1 ring-primary/20"
                : "bg-card text-muted-foreground hover:bg-accent",
            )}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
          className="h-8 flex-1 text-xs" placeholder="USDC amount" aria-label="USDC amount" />
        <Button size="xs" variant="ghost" onClick={() => setAmount(two(balNum))}>Max</Button>
        <Button size="sm" disabled={busy !== null || !enough || !corridorKey} onClick={prepare}>
          {busy === "prepare" ? <Loader2 className="size-3.5 animate-spin" /> : "Cash out"}
        </Button>
      </div>
      {amount !== "" && activeBalMinor != null && !enough && (
        <p className="mt-1.5 text-xs text-amber-600">
          {amtNum < minUsdc
            ? `Min ${minUsdc} USDC for ${corridor?.currency ?? "this corridor"}.`
            : signMode === "wallet" ? "More than this wallet holds on Arc." : "More than the seller holds."}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {prepared && !broadcast && (
        <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center justify-center gap-2 text-sm font-semibold tabular-nums">
            <span>{two(prepared.source.amount)} USDC</span>
            <ArrowRight className="size-3.5 text-muted-foreground" />
            <span className="text-emerald-600">{two(prepared.destination.amount)} {prepared.destination.currency}</span>
          </div>
          <div className="text-center text-xs text-muted-foreground">
            fee {prepared.fee} {prepared.feeCurrency} · margin {prepared.spreadBps} bps · {prepared.status}
          </div>
          {signMode === "wallet" && (
            <p className="text-center text-[10px] text-muted-foreground">
              Your wallet will be asked twice: approve Permit2, then sign the payment intent.
            </p>
          )}
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            <span>
              <TriangleAlert className="mr-1 inline size-3.5 text-amber-600" />
              Broadcast is <strong className="text-foreground">irreversible</strong> — the seller's USDC leaves (testnet funds).
            </span>
          </label>
          <Button size="sm" variant="destructive" className="w-full" disabled={!confirmed || busy !== null} onClick={doBroadcast}>
            {busy !== null && busy !== "prepare"
              ? <><Loader2 className="size-3.5 animate-spin" /> {busyLabel}</>
              : "Broadcast (irreversible)"}
          </Button>
        </div>
      )}

      {broadcast && (
        <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            {broadcast.finalStatus === "COMPLETED"
              ? <CircleCheck className="size-3.5 text-emerald-600" />
              : <TriangleAlert className="size-3.5 text-amber-600" />}
            Cash-out
            <Badge variant="outline" className={cn("ml-auto", STATUS_TONE[broadcast.finalStatus])}>
              {broadcast.finalStatus || "—"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
            {broadcast.lifecycle.map((s, i) => (
              <span key={s} className="flex items-center gap-1">
                {i > 0 && <ArrowRight className="size-2.5" />}
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{s}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
