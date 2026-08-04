"use client";

import { useEffect, useState, useTransition } from "react";
import { useAccount, useSignTypedData, useSwitchChain } from "wagmi";
import {
  createOrderAction, fundAction, releaseAction, refundAction, refreshPayoutAction,
  retrySettlementAction,
  snapshotAction, payoutOptionsAction, fxProbeAction, bankEstimateAction,
  demoBuyerAction, arcUsdcAction, authTypedDataAction, paySignedAction,
  listOrdersAction,
  type ActionResult, type FxProbe, type OrderSummary, type PayoutOptions, type Snapshot,
} from "./actions";
import { walletErrorMessage } from "./wallet-errors";
import { ARC_TESTNET_CHAIN_ID } from "../../src/constants/arc";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ToneBadge, stateTone, statusLabel } from "./_ui";
import { Button } from "@/components/ui/button";
import {
  Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { sourceChainByName } from "@/lib/source-chain";

const WEDGES = [
  { value: "contractor_payout", label: "Kontraktor / payout B2B" },
  { value: "digital_goods", label: "Digital goods / SaaS" },
] as const;

type Destination = "wallet" | "bank";

const EUR = (minor: string | null) => (minor == null ? "—" : `€${(Number(minor) / 1e6).toFixed(2)}`);
const USDC = (minor: string | null) => (minor == null ? "—" : `${(Number(minor) / 1e6).toFixed(4)} USDC`);

/** Money at whatever scale its rail reports — 6 for a mock, 2 for a live payout. */
const amount = (minor: string, scale: number, currency: string) =>
  `${(Number(minor) / 10 ** scale).toFixed(2)} ${currency}`;

// Any of the source chains links to its own explorer; everything else is Arc.
const txUrl = (chain: string | null, hash: string) => {
  const src = sourceChainByName(chain);
  return src ? `${src.explorerUrl}/tx/${hash}` : `https://testnet.arcscan.app/tx/${hash}`;
};


/** States in which the money has come to rest, either way. */
const TERMINAL = new Set(["released", "paid_out", "refunded", "failed"]);

type StepStatus = "todo" | "active" | "done";

function Step({
  n, title, subtitle, status, children,
}: {
  n: number;
  title: string;
  subtitle: string;
  status: StepStatus;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <ToneBadge
        tone={status === "done" ? "success" : status === "active" ? "progress" : "neutral"}
        className="mt-0.5 size-6 justify-center rounded-full p-0 font-mono text-xs"
      >
        {n}
      </ToneBadge>
      <div className="min-w-0 flex-1 space-y-2 pb-4">
        <div>
          <p className={status === "todo" ? "text-sm text-muted-foreground" : "text-sm font-medium"}>
            {title}
          </p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {children}
      </div>
    </li>
  );
}

export default function DemoPanels() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [price, setPrice] = useState("1.50");
  const [wedge, setWedge] = useState<(typeof WEDGES)[number]["value"]>("digital_goods");
  const [dest, setDest] = useState<Destination>("wallet");
  const [opts, setOpts] = useState<PayoutOptions | null>(null);
  const [probe, setProbe] = useState<FxProbe>(null);
  const [bankUsdc, setBankUsdc] = useState<string | null>(null);
  const [demoBuyer, setDemoBuyer] = useState<string | null>(null);
  const [history, setHistory] = useState<OrderSummary[]>([]);
  const [walletUsdc, setWalletUsdc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();

  const apply = (r: ActionResult) => {
    if (r.ok) { setSnap(r.snapshot); setError(null); }
    else setError(r.error);
  };

  const refreshHistory = () => listOrdersAction().then(setHistory);

  useEffect(() => {
    payoutOptionsAction().then(setOpts);
    fxProbeAction().then(setProbe);
    demoBuyerAction().then(setDemoBuyer);
    refreshHistory();
  }, []);

  // Re-read the list whenever the order on screen settles into a new state, so
  // history reflects what just happened without a manual refresh.
  useEffect(() => { if (snap?.state) refreshHistory(); }, [snap?.state, snap?.orderId]);

  // Arc USDC of the connected wallet. This page funds from Arc directly — the
  // cross-chain rails live in the marketplace demo — so a wallet with a balance
  // elsewhere would fail at signing time with nothing on screen explaining why.
  useEffect(() => {
    if (!address) { setWalletUsdc(null); return; }
    arcUsdcAction(address).then(setWalletUsdc);
  }, [address, snap?.state]);

  // The bank figure is asked of the RAIL, once the typing settles.
  //
  // It cannot be scaled from the probe the way the wallet figure is: CPN's fees
  // are partly flat, so a linear estimate would understate small orders. That
  // makes it a live call per amount — hence the debounce, and hence it only
  // runs when a bank order is actually on the table.
  useEffect(() => {
    if (dest !== "bank") { setBankUsdc(null); return; }
    const minor = Math.round(parseFloat(price || "0") * 1e6);
    if (!Number.isFinite(minor) || minor <= 0) { setBankUsdc(null); return; }
    let cancelled = false;
    const id = setTimeout(() => {
      bankEstimateAction(String(minor)).then((v) => { if (!cancelled) setBankUsdc(v); });
    }, 600);
    return () => { cancelled = true; clearTimeout(id); };
  }, [dest, price]);

  // Poll while an order exists and something is in flight, so intermediate
  // states (funding_pending, payout_pending) surface before the action resolves.
  useEffect(() => {
    // `settlement_pending` ends in `_pending` and is NOT in flight — it is a
    // resting state waiting on a human to retry. Polling it every four seconds
    // forever asks a rate-limited RPC a question whose answer cannot change.
    const inFlight =
      snap && (pending || (snap.state.endsWith("_pending") && snap.state !== "settlement_pending"));
    if (!snap || !inFlight) return;
    const id = setInterval(() => { snapshotAction(snap.orderId).then(apply); }, 4000);
    return () => clearInterval(id);
  }, [snap, pending]);

  const run = (fn: () => Promise<ActionResult>) => start(async () => apply(await fn()));

  const state = snap?.state;
  const canCreate = !snap || TERMINAL.has(snap.state);
  const canFund = state === "created";
  const canRelease = state === "funded";
  // Captured but never converted. A separate call from `release`, because the
  // escrow has already been emptied — see retrySettlementAction.
  const canRetry = state === "settlement_pending";
  const canRefund = state === "funded" || state === "released";
  // Only a bank order has a rail to re-read; a mock instruction has no status.
  const canRefresh = snap?.payoutTo === "bank" && (state === "payout_pending" || state === "paid_out");

  // The timeline describes the order on screen, not the toggle — those diverge
  // the moment an order exists and the toggle is moved afterwards. Before any
  // order exists the toggle is all there is.
  const shown: Destination = (snap?.payoutTo ?? dest) as Destination;
  const bank = shown === "bank";

  const priceMinor = BigInt(Math.round(parseFloat(price || "0") * 1e6));
  const belowMin = Boolean(opts && priceMinor < BigInt(opts.minEURMinor));
  const bankBlocked = dest === "bank" && (!opts?.enabled || belowMin);

  // The wallet figure scales from one probe — a swap's cost is a spread, so one
  // quote describes every size. INDICATIVE either way: the binding number is
  // computed at createOrder against a quote that lives 30–60 seconds.
  const walletUsdcEstimate = (() => {
    if (!probe || priceMinor <= 0n) return null;
    const net = (priceMinor * BigInt(probe.amountInMinor)) / BigInt(probe.amountOutMinor);
    return net + (net * BigInt(probe.bufferBps)) / 10_000n;
  })();

  const estimate = dest === "bank" ? (bankUsdc ? BigInt(bankUsdc) : null) : walletUsdcEstimate;

  // Who pays. A connected wallet signs its own authorization; with none, the
  // demo falls back to a server-held key — which is the thing worth replacing.
  const payer = isConnected && address ? address : demoBuyer;
  const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const shortWallet = walletUsdcEstimate == null || walletUsdc == null
    ? false
    : BigInt(walletUsdc) < walletUsdcEstimate;

  /**
   * Connected-wallet fund: fetch the ERC-3009 typed data, sign it in the
   * browser wallet, hand the signature back for the operator to relay.
   *
   * The domain is Arc's, and a wallet refuses to sign typed data for a chain it
   * is not on — WITHOUT prompting. Nothing else in this path moves funds across
   * chains, so the refusal would arrive looking like a declined signature. Ask
   * for the network first and let the wallet prompt.
   */
  const signAndFund = async (orderId: string): Promise<ActionResult> => {
    const td = await authTypedDataAction(orderId);
    if (!td.ok) return { ok: false, error: td.error };
    const m = td.typedData;

    if (chainId !== ARC_TESTNET_CHAIN_ID) {
      try {
        await switchChainAsync({ chainId: ARC_TESTNET_CHAIN_ID });
      } catch (e) {
        return {
          ok: false,
          error: walletErrorMessage(
            e,
            "Arc Testnet is needed to sign this authorization — the network switch was declined. Nothing was signed.",
          ),
        };
      }
    }

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
    } catch (e) {
      // Only 4001 is a rejection. Calling every failure "rejected" sends the
      // user hunting for a prompt they never declined, and buries the cause.
      return { ok: false, error: walletErrorMessage(e, "Signature rejected in wallet") };
    }
    return paySignedAction(orderId, signature);
  };

  const bankNote = !opts
    ? null
    : !opts.enabled
      ? "Bank payout is not wired in this deployment — CIRCLE_CPN_KEY is missing."
      : belowMin
        ? `The ${opts.corridor} corridor will not take an order below ${EUR(opts.minEURMinor)}. ` +
          "Its floor is charged on the destination side, so a smaller order is refused at createOrder."
        : null;

  const step = (done: boolean, active: boolean): StepStatus =>
    done ? "done" : active ? "active" : "todo";

  const funded = Boolean(state && !["created", "funding_pending"].includes(state));
  const settled = Boolean(state && ["released", "payout_pending", "paid_out"].includes(state));
  const paid = state === "paid_out" || (state === "released" && !bank);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Interactive demo — the whole flow through the SDK</CardTitle>
        <CardDescription>
          One order, five calls, from multi-chain USDC to the recipient. Testnet. The buyer is
          server-signed with a demo key (in production the buyer signs in their own wallet).
          On-chain steps take 1–2 minutes.
        </CardDescription>
        {/* The connect control used to sit here too. `/sdk` has the shared demo
            header now, which carries one — and two wallet buttons on one screen
            is two places to wonder which one is connected. */}
        <CardAction className="flex items-center gap-2">
          {state && (
            <ToneBadge tone={pending ? "progress" : stateTone(state)} className="font-mono">
              {pending ? "working…" : statusLabel(state)}
            </ToneBadge>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ---- Order setup ------------------------------------------------ */}
        <div className="flex flex-wrap items-end gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="demo-price">priceEUR</Label>
            <Input id="demo-price" value={price} onChange={(e) => setPrice(e.target.value)}
              disabled={!canCreate || pending} className="w-24" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="demo-wedge">wedge</Label>
            {/* `items` is what lets <SelectValue/> show the label rather than
                the raw enum value — Base UI has no equivalent of radix's
                trigger-side children. */}
            <Select items={WEDGES} value={wedge} onValueChange={(v) => setWedge(v as typeof wedge)}
              disabled={!canCreate || pending}>
              <SelectTrigger id="demo-wedge">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEDGES.map((w) => <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>payoutTo</Label>
            <ToggleGroup variant="outline" value={[dest]}
              onValueChange={([v]) => v && setDest(v as Destination)}
              disabled={!canCreate || pending}>
              <ToggleGroupItem value="wallet" className="px-3 text-xs">wallet</ToggleGroupItem>
              <ToggleGroupItem value="bank" className="px-3 text-xs">bank</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {/* Indicative USDC, updated as the price is typed. */}
        <p className="text-xs text-muted-foreground">
          {estimate != null ? (
            <>
              Buyer pays about <span className="font-mono text-foreground">{USDC(estimate.toString())}</span>{" "}
              for {EUR(priceMinor.toString())} — indicative. The binding figure is computed at{" "}
              <span className="font-mono">createOrder</span>, against a quote that lives 30–60 seconds.
            </>
          ) : dest === "bank" && !bankBlocked ? (
            "Asking the payout rail for a figure…"
          ) : (
            "No estimate available — the guaranteed euro price is the one that binds."
          )}
        </p>

        {/* Who signs. This is the property the page exists to show. */}
        <p className="text-xs text-muted-foreground">
          {isConnected && address ? (
            <>
              Payer: <span className="font-mono text-foreground">{shortAddr(address)}</span> — your wallet signs the
              ERC-3009 authorization itself and the operator only relays it. No server key touches this order.
              {walletUsdc != null && (
                <> Arc USDC: <span className="font-mono">{USDC(walletUsdc)}</span>.</>
              )}
              {shortWallet && (
                <span className="text-destructive">
                  {" "}That is below the estimate — funding will fail. This page pays from Arc directly; the
                  cross-chain rails live in the marketplace demo.
                </span>
              )}
            </>
          ) : (
            <>
              Payer: <span className="font-mono">{demoBuyer ? shortAddr(demoBuyer) : "demo buyer"}</span> — a
              server-held key, because no wallet is connected. Connect one to sign in your own browser instead.
            </>
          )}
        </p>

        <p className="text-xs text-muted-foreground">
          {dest === "wallet"
            ? "wallet — settlement ends at EURC on Arc and the host is handed a MOCK payout instruction. Nothing reaches a bank."
            : `bank — release() drives the off-ramp itself over ${opts?.corridor ?? "CPN"}. The swap is skipped: CPN only accepts USDC, and its quote is what pins the euro amount.`}
        </p>

        {dest === "bank" && bankNote && (
          <Alert>
            <AlertDescription>{bankNote}</AlertDescription>
          </Alert>
        )}

        <Separator />

        {/* ---- The flow --------------------------------------------------- */}
        <ol>
          <Step n={1} title="createOrder" status={step(Boolean(snap), !snap)}
            subtitle="Screen the addresses, lock the FX quote, size the order, store it.">
            <Button size="sm" disabled={!canCreate || pending || bankBlocked}
              onClick={() => run(() =>
                createOrderAction(priceMinor.toString(), wedge, dest, address ?? undefined))}>
              createOrder
            </Button>
          </Step>

          <Step n={2} title={isConnected ? "fund — signed in your wallet" : "fund — signed by the demo key"}
            status={step(funded, canFund || state === "funding_pending")}
            subtitle={
              isConnected
                ? "Your wallet signs the ERC-3009 authorization; the operator relays it, so you pay no gas."
                : "USDC on Arc → a gasless ERC-3009 authorize into escrow, signed server-side."
            }>
            {canFund && (
              <Button size="sm" variant="outline" disabled={pending}
                onClick={() => run(() =>
                  isConnected ? signAndFund(snap!.orderId) : fundAction(snap!.orderId))}>
                {isConnected ? "sign & fund" : "fund (gasless)"}
              </Button>
            )}
          </Step>

          <Step n={3}
            title={bank ? "release → capture + CPN broadcast" : "release → capture + floored swap"}
            status={step(settled, canRelease)}
            subtitle={
              bank
                ? "Captures the escrow, then quotes CPN pinned to priceEUR and broadcasts. IRREVERSIBLE once broadcast."
                : "Captures the escrow, then swaps USDC→EURC with stopLimit = priceEUR. The recipient gets ≥ €P or it reverts."
            }>
            {canRelease && (
              <Button size="sm" disabled={pending} onClick={() => run(() => releaseAction(snap!.orderId))}>
                {bank ? "release (capture → off-ramp)" : "release (capture → swap floor)"}
              </Button>
            )}

            {/* The escrow is empty here and the order is holding USDC that never
                reached its currency. `release` would capture a second time, so
                this is a DIFFERENT call — and until it existed on the facade the
                demo simply left the order stranded with no button at all. */}
            {canRetry && (
              <Alert>
                <AlertTitle className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>Captured, but not yet converted</span>
                  <ToneBadge tone="progress">retryable</ToneBadge>
                </AlertTitle>
                <AlertDescription className="space-y-2">
                  <span>
                    {snap?.failureReason ??
                      "The capture succeeded and the settlement did not. The funds are with the receiver as USDC — safe, and one call from finished."}
                  </span>
                  <Button size="sm" disabled={pending}
                    onClick={() => run(() => retrySettlementAction(snap!.orderId))}>
                    {bank ? "retrySettlement (re-quote → broadcast)" : "retrySettlement (swap again)"}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </Step>

          <Step n={4} title={bank ? "payout — money left the wallet" : "payout — MOCK instruction"}
            status={step(Boolean(snap?.payout), settled && !snap?.payout)}
            subtitle={
              bank
                ? "A live payout on a real payment network. `executed` means BROADCAST, not delivered."
                : "Nothing moved. The host receives a structured instruction it must run itself."
            }>
            {snap?.payout && (
              <Alert>
                <AlertTitle className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    {amount(snap.payout.source.amountMinor, snap.payout.source.scale, snap.payout.source.currency)}
                    {" → "}
                    {amount(snap.payout.target.amountMinor, snap.payout.target.scale, snap.payout.target.currency)}
                    {snap.payout.target.estimated && (
                      <span className="ml-1 text-muted-foreground">(estimated)</span>
                    )}
                  </span>
                  {/* MOCK is amber, not grey: it is a caution, and it should read
                      as one next to a LIVE payout. */}
                  <ToneBadge tone={snap.payout.label === "LIVE" ? "success" : "warning"}>
                    {snap.payout.label}
                  </ToneBadge>
                </AlertTitle>
                <AlertDescription className="space-y-1">
                  <span>{snap.payout.disclaimer}</span>
                  {snap.payout.reference && (
                    <span className="block font-mono text-xs">
                      {snap.payout.reference} · {snap.payout.status}
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </Step>

          <Step n={5} title="refreshPayout" status={step(state === "paid_out", Boolean(canRefresh))}
            subtitle={
              bank
                ? "A broadcast returns before its transfer is mined, so the ledger row is born `pending`. This second read settles it with the Arc hash — the same path a webhook takes."
                : "Not applicable to a wallet order: a MOCK instruction has no rail to re-read."
            }>
            {canRefresh && (
              <Button size="sm" variant="outline" disabled={pending}
                onClick={() => run(() => refreshPayoutAction(snap!.orderId))}>
                refreshPayout
              </Button>
            )}
          </Step>
        </ol>

        {canRefund && (
          <Button size="sm" variant="destructive" disabled={pending}
            onClick={() => run(() => refundAction(snap!.orderId))}>
            refund
          </Button>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* ---- Inspector -------------------------------------------------- */}
        {snap && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Execution Inspector</CardTitle>
              <CardAction>
                <span className="font-mono text-xs text-muted-foreground">{snap.orderId}</span>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-5">
                <div><dt className="text-muted-foreground">priceEUR</dt><dd>{EUR(snap.priceEUR)}</dd></div>
                <div><dt className="text-muted-foreground">usdcAmount</dt><dd>{USDC(snap.usdcAmount)}</dd></div>
                <div><dt className="text-muted-foreground">wedge</dt><dd className="font-mono">{snap.wedge}</dd></div>
                <div><dt className="text-muted-foreground">payoutTo</dt><dd className="font-mono">{snap.payoutTo}</dd></div>
                <div><dt className="text-muted-foreground">refund to</dt><dd>{snap.receivingChain}</dd></div>
              </dl>

              {snap.payments.length > 0 && (
                <>
                  <Separator />
                  <ul className="space-y-1">
                    {snap.payments.map((p, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
                        <span className="w-24 shrink-0 font-mono">{p.kind}</span>
                        <span className="text-muted-foreground">{p.status}</span>
                        {p.txHash && p.txHash.startsWith("0x") && p.txHash.length > 20 ? (
                          <a href={txUrl(p.chain, p.txHash)} target="_blank" rel="noopener noreferrer"
                            className="break-all font-mono text-primary underline-offset-4 hover:underline">
                            {p.txHash.slice(0, 10)}…{p.txHash.slice(-8)}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">{p.txHash ?? "—"}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* ---- History ---------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent orders</CardTitle>
            <CardDescription>
              Read from the store, not from this tab — these survive a refresh. Click one to reopen it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground">No orders yet.</p>
            ) : (
              <ul className="space-y-1">
                {history.map((o) => (
                  <li key={o.id}>
                    <button type="button" disabled={pending}
                      onClick={() => run(() => snapshotAction(o.id))}
                      className="flex w-full flex-wrap items-baseline gap-2 rounded-2xl px-3 py-1.5 text-left text-xs hover:bg-muted hover:text-muted-foreground disabled:opacity-50">
                      <span className="min-w-0 flex-1 truncate font-mono">{o.id}</span>
                      <span>{EUR(o.priceEUR)}</span>
                      <Badge variant="outline" className="font-mono">{o.payoutTo}</Badge>
                      {o.origin === "sdk" && o.signer && (
                        <Badge variant="outline" className="font-mono">
                          {o.signer === "wallet" ? "wallet-signed" : "demo key"}
                        </Badge>
                      )}
                      <ToneBadge tone={stateTone(o.state)} className="font-mono">
                        {statusLabel(o.state)}
                      </ToneBadge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
}
