"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  RiArrowRightLine, RiCashLine, RiCheckboxCircleLine, RiErrorWarningLine, RiLoader4Line, RiWallet3Line,
} from "@remixicon/react";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { erc20Abi } from "viem";
import {
  cpnBroadcastAction,
  cpnBroadcastSignedAction,
  cpnIntentAction,
  cpnPrepareAction,
  type BroadcastView,
  type PreparedView,
} from "./ramp.actions";
import { normalizeTypedData, type MessageToBeSigned } from "../../src/ramp/cpn-sign.ts";
import { ARC_TESTNET_CHAIN_ID, PERMIT2_ADDRESS, USDC_ADDRESS } from "../../src/constants/arc.ts";
import { withToast } from "./toast";
import { ToneBadge, railTone, statusLabel } from "./_ui";
import { Button } from "@/components/ui/button";
import {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Corridor = {
  key: string; label: string; currency: string; method: string; minUsdc: number; roadmap: boolean;
};

/** Who signs the Permit2 intent that lets CPN pull the USDC. */
type SignMode = "server" | "wallet";

const two = (decimal: string | number) => Number(decimal).toFixed(2);

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
/** `className` is how the withdraw page places this panel on its grid. */
export default function SellerCashout({ className, corridors, seller, onDone }: {
  className?: string;
  /** Both read once with the page — this panel used to fetch each on mount,
   *  through the Server Action queue, behind everything else on the screen. */
  corridors: Corridor[];
  seller: { address: string; usdcMinor: string } | null;
  /** Re-read the page (balances and both histories) once a cash-out lands. */
  onDone: () => void;
}) {
  const [corridorKey, setCorridorKey] = useState<string>("");
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

  // Never land on a corridor the toggle then refuses to select.
  useEffect(() => {
    if (corridorKey) return;
    const first = corridors.find((c) => !c.roadmap) ?? corridors[0];
    if (first) setCorridorKey(first.key);
  }, [corridors, corridorKey]);

  // A connected wallet is the interesting case, so default to it — but never
  // silently: the mode is visible and switchable.
  useEffect(() => { if (isConnected) setSignMode("wallet"); else setSignMode("server"); }, [isConnected]);

  // The server-held seller balance arrives with the page. Prefilled ONCE, on
  // the first value seen: re-prefilling on every poll would overwrite an amount
  // the user was in the middle of typing.
  const balMinor = seller?.usdcMinor ?? null;
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || balMinor == null) return;
    prefilled.current = true;
    setAmount(two(Number(balMinor) / 1e6));
  }, [balMinor]);

  // The connected wallet's own USDC on Arc — what IT can actually cash out.
  useEffect(() => {
    if (!address || !publicClient) { setWalletBalMinor(null); return; }
    publicClient
      .readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] })
      .then((b) => setWalletBalMinor(b.toString()))
      .catch(() => setWalletBalMinor(null));
  }, [address, publicClient, broadcast]);

  const corridor = corridors.find((c) => c.key === corridorKey);
  const roadmapLabels = corridors.filter((c) => c.roadmap).map((c) => c.label).join(" · ");
  const minUsdc = corridor?.minUsdc ?? 11;
  const activeBalMinor = signMode === "wallet" ? walletBalMinor : balMinor;
  const balNum = activeBalMinor ? Number(activeBalMinor) / 1e6 : 0;
  const amtNum = Number(amount || "0");
  const enough = amtNum >= minUsdc && amtNum <= balNum;

  const reset = () => { setPrepared(null); setBroadcast(null); setConfirmed(false); setError(null); };
  // Base UI's ToggleGroup reports the whole pressed set; single-select means one
  // entry, and an empty array when the pressed item is clicked again.
  const pickCorridor = ([key]: string[]) => { if (!key) return; setCorridorKey(key); reset(); };
  const pickMode = ([m]: string[]) => { if (!m) return; setSignMode(m as SignMode); reset(); };

  const prepare = () =>
    start(async () => {
      setBusy("prepare"); setError(null); setBroadcast(null); setConfirmed(false);
      // The sender address is baked into the intent, so it must be decided now:
      // an intent prepared for one address cannot later be signed by another.
      const r = await withToast("Quoting CPN and preparing the payment intent",
        () => cpnPrepareAction(amount, corridorKey, signMode === "wallet" ? address : undefined));
      if (r.ok) setPrepared(r.prepared);
      else { setPrepared(null); setError(r.error); }
      setBusy(null);
    });

  /** Server-held key signs and broadcasts — the path proven to COMPLETED. */
  const doBroadcastServer = async (paymentId: string) => {
    setBusy("broadcast");
    const r = await withToast("Broadcasting to CPN — following the payment to a terminal status",
      () => cpnBroadcastAction(paymentId));
    if (r.ok) { setBroadcast(r.result); onDone(); } else setError(r.error);
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
    const r = await withToast("Broadcasting the wallet-signed intent to CPN",
      () => cpnBroadcastSignedAction(paymentId, signature));
    if (r.ok) { setBroadcast(r.result); onDone(); } else setError(r.error);
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
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-bold">
          <RiCashLine className="size-4 text-muted-foreground" />
          Cash out to fiat · CPN
        </CardTitle>
        <CardDescription className="truncate">
          Sales proceeds in USDC → local currency in a bank
        </CardDescription>
        <CardAction>
          <span className="text-sm text-muted-foreground">
            <b className="tabular-nums text-foreground">{activeBalMinor ? two(balNum) : "…"}</b> USDC
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Who signs. The distinction is the point, so it is never implicit. */}
        <div className="space-y-1.5">
          <ToggleGroup variant="outline" size="sm" value={[signMode]} onValueChange={pickMode}>
            <ToggleGroupItem value="server">Demo key</ToggleGroupItem>
            <ToggleGroupItem value="wallet" disabled={!isConnected}>
              <RiWallet3Line /> My wallet
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="text-sm text-muted-foreground">
            {signMode === "wallet"
              ? "the wallet holding the USDC signs — no server key"
              : "a server-held testnet key stands in for the seller"}
          </p>
        </div>

        {/* Corridor selector. The order is the server's — EUR/SEPA and USD/WIRE
            first, the roadmap corridors after them. */}
        <div className="space-y-1.5">
          <ToggleGroup variant="outline" size="sm" value={[corridorKey]} onValueChange={pickCorridor}
            className="flex-wrap">
            {corridors.map((c) => (
              <ToggleGroupItem key={c.key} value={c.key} disabled={c.roadmap}>{c.label}</ToggleGroupItem>
            ))}
          </ToggleGroup>
          {roadmapLabels && (
            <p className="text-sm text-muted-foreground">
              {roadmapLabels} — implemented, and on the roadmap. This phase cashes out over EUR/SEPA and USD/WIRE.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
            className="flex-1" placeholder="USDC amount" aria-label="USDC amount" />
          <Button size="sm" variant="ghost" onClick={() => setAmount(two(balNum))}>Max</Button>
          <Button size="sm" disabled={busy !== null || !enough || !corridorKey} onClick={prepare}>
            {busy === "prepare" ? <RiLoader4Line className="animate-spin" /> : "Cash out"}
          </Button>
        </div>
        {amount !== "" && activeBalMinor != null && !enough && (
          <p className="text-sm text-muted-foreground">
            {amtNum < minUsdc
              ? `Min ${minUsdc} USDC for ${corridor?.currency ?? "this corridor"}.`
              : signMode === "wallet" ? "More than this wallet holds on Arc." : "More than the seller holds."}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {prepared && !broadcast && (
          <>
            <Separator />
            <div className="flex items-center justify-center gap-2 text-sm font-semibold tabular-nums">
              <span>{two(prepared.source.amount)} USDC</span>
              <RiArrowRightLine className="size-3.5 text-muted-foreground" />
              <span>{two(prepared.destination.amount)} {prepared.destination.currency}</span>
            </div>
            <p className="text-center text-sm text-muted-foreground">
              fee {prepared.fee} {prepared.feeCurrency} · margin {prepared.spreadBps} bps · {prepared.status}
            </p>
            {signMode === "wallet" && (
              <p className="text-center text-sm text-muted-foreground">
                Your wallet will be asked twice: approve Permit2, then sign the payment intent.
              </p>
            )}
            <div className="flex items-start gap-2">
              <Checkbox id="cpn-confirm" checked={confirmed}
                onCheckedChange={(c) => setConfirmed(c === true)} className="mt-0.5" />
              <Label htmlFor="cpn-confirm" className="text-sm font-normal text-muted-foreground">
                <RiErrorWarningLine className="size-3.5" />
                <span>
                  Broadcast is <strong className="text-foreground">irreversible</strong> — the seller&apos;s USDC
                  leaves (testnet funds).
                </span>
              </Label>
            </div>
            <Button size="sm" variant="destructive" className="w-full" disabled={!confirmed || busy !== null}
              onClick={doBroadcast}>
              {busy !== null && busy !== "prepare"
                ? <><RiLoader4Line className="animate-spin" /> {busyLabel}</>
                : "Broadcast (irreversible)"}
            </Button>
          </>
        )}

        {broadcast && (
          <>
            <Separator />
            <div className="flex items-center gap-1.5 text-sm font-medium">
              {broadcast.finalStatus === "COMPLETED"
                ? <RiCheckboxCircleLine className="size-3.5" />
                : <RiErrorWarningLine className="size-3.5" />}
              Cash-out
              <ToneBadge tone={railTone(broadcast.finalStatus)} className="ml-auto">
                {statusLabel(broadcast.finalStatus)}
              </ToneBadge>
            </div>
            <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
              {broadcast.lifecycle.map((s, i) => (
                <span key={s} className="flex items-center gap-1">
                  {i > 0 && <RiArrowRightLine className="size-3" />}
                  <ToneBadge tone={railTone(s)}>{statusLabel(s)}</ToneBadge>
                </span>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
