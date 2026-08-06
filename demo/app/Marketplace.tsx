"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useAccount, useSignTypedData, useSwitchChain } from "wagmi";
import { ARC_TESTNET_CHAIN_ID } from "../../src/constants/arc";
import { fundsMayBeInFlight, walletErrorMessage } from "./wallet-errors";
import {
  RiArrowDownSLine, RiBankLine, RiCheckboxCircleLine, RiCloseLine, RiEditLine, RiErrorWarningLine,
  RiExternalLinkLine, RiShoppingCartLine, RiStore2Line, RiTruckLine,
} from "@remixicon/react";
import { CATALOG, canPayoutToBank, fmtEUR } from "../lib/catalog";
import {
  mpCheckout, mpPay, mpConfirm, mpDispute, mpShip, mpRelease, mpRefund,
  mpAuthTypedData, mpPaySigned,
  mpOrderAmount, mpMarkFunding, mpRecordWalletFunding, mpRefreshPayout, mpExpireOrder,
  type OrderView, type PaySource, type Balances, type RelayView, type PriceHint,
} from "./marketplace.actions";
import type { BoardSnapshot } from "../lib/board.server";
import { getJson, useLive } from "./live";
import { useWalletBalance } from "./wallet-balance";
import { cn } from "@/lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
// App Kit is ~370 kB in the browser and only the connected-wallet path needs it,
// so the rails module is pulled in on demand rather than at first paint.
import type { Eip1193 } from "./wallet-rails";
const rails = () => import("./wallet-rails");
import { Empty, Panel, SectionLabel, StatusBadge, ToneBadge, num, shortAddr, shortHash, usd } from "./_ui";
import { useSellerWallet } from "./seller-wallet";
import { withActionToast, withToast } from "./toast";
import SellerWalletPicker from "./SellerWalletPicker";
import {
  DEFAULT_SOURCE_CHAIN_ID, SOURCE_CHAINS, sourceChain, sourceChainByName, type SourceChainId,
} from "@/lib/source-chain";

// Anything recorded against a source chain links to that chain's explorer;
// everything else is on Arc. Matching by name rather than by a single constant
// is what keeps a Base or Sepolia burn from linking to Arc's explorer.
const txUrl = (chain: string | null, h: string) => {
  const src = sourceChainByName(chain);
  return src ? `${src.explorerUrl}/tx/${h}` : `https://testnet.arcscan.app/tx/${h}`;
};

/**
 * How long after "shipped" the host must wait before it can settle.
 *
 * The host is the arbiter — that is the honest shape of this product — but an
 * arbiter that can settle in the same second the seller marks a parcel shipped
 * gives the buyer no chance to dispute at all. Buyer confirmation ends the wait
 * immediately, so the window only ever costs time when nobody has spoken.
 * Minutes, not days, because this is a demo someone watches end to end.
 */
const DISPUTE_WINDOW_MS = 5 * 60_000;

/**
 * What a release is actually doing, which differs enough to be worth saying:
 * a wallet order captures then runs the floored swap, a bank order captures
 * then broadcasts to a payment network and waits on it.
 */
const releaseLabel = (v: OrderView) =>
  v.payoutTo === "bank"
    ? "Releasing → capture, then CPN payout to the bank"
    : "Releasing → capture, then floored swap to EURC";

/** "4:07" from milliseconds. */
const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The primary action, pinned to the bottom of the panel it lives in.
 *
 * Each role panel is its own scrollport (`Panel` in `_ui.tsx`), and the payment
 * options stack tall enough that the button which actually moves money fell
 * below the fold on a laptop — the buyer had to scroll to reach the one control
 * the screen exists for. Pinning the footer keeps the options scrollable and the
 * button where the hand already is.
 *
 * The cards between here and that scrollport must NOT clip: the preset's Card
 * carries `overflow-hidden`, and a clipped ancestor becomes the scroll container
 * sticky measures itself against — the footer would sit in flow and never move.
 * Hence `overflow-visible` on the order card and on each pay card.
 *
 * `rounded-none` overrides the footer's stock bottom radius. Pinned mid-card,
 * rounded corners would let two arcs of the content scrolling underneath show
 * through; at rest the footer's box stops inside the card's own bottom padding,
 * so square corners over the same `bg-card` are invisible either way.
 */
const STICKY_ACTION =
  "sticky bottom-0 z-10 flex-col items-stretch gap-2 rounded-none bg-card/95 pt-3 shadow-[0_-1px_0_0_var(--border)] backdrop-blur";

const STAGES = ["Paid", "Shipped", "Received", "Done"];
const STAGE_OF: Record<string, number> = {
  waiting_payment: -1, processing_payment: -1,
  paid: 0, shipped: 1, confirmed: 2, settling: 2, completed: 3,
  dispute: 1, refunding: 1, refunded: 1,
};

/**
 * Payment rails and the balance each draws from, vs the order's usdcAmount.
 *
 * The two cross-chain rails take a source chain, so the list is built per chain
 * rather than fixed: `bridge` spends that chain's USDC, `unified` spends the
 * Gateway balance but draws it down from that chain's deposit. `arc` ignores it.
 */
const railsFor = (from: SourceChainId): Array<{
  id: PaySource; label: string; bal: (b: Balances) => number; fee?: number; note: string;
}> => {
  const c = sourceChain(from);
  return [
    { id: "arc", label: "USDC on Arc", bal: (b) => num(b.buyerArcUsdc), note: "direct, fastest" },
    { id: "unified", label: "Unified Balance", bal: (b) => num(b.buyerGatewayUsdc), fee: 1, note: `Gateway spend → Arc · draws from ${c.label}` },
    { id: "bridge", label: `${c.label} bridge`, bal: (b) => num(b.buyerSrcUsdc?.[from] ?? "0"), note: `CCTP, ${c.finality}` },
  ];
};

/* ── panel height ─────────────────────────────────────────────────────────── */

/** How many order rows a role column shows before its body starts scrolling. */
const PANEL_ROWS = 7;

/** What `useRowCappedPanels` hands one column; spread straight onto its `Panel`. */
type PanelCap = { bodyRef: React.Ref<HTMLDivElement>; bodyMaxHeight: number | null };

/**
 * One height for all three role columns: as tall as `PANEL_ROWS` order rows,
 * and not a pixel taller.
 *
 * Measured off the DOM rather than declared, because an order row has no fixed
 * height — a card carries a status badge and, while it is open, a tracker, a
 * rail chooser or an alert, and the host's history rows are a different shape
 * again. The distance from the top of a column's body to the top of its
 * (PANEL_ROWS + 1)-th row IS the height that shows exactly seven and hides the
 * eighth. The tallest of the three wins, so no column shows FEWER than seven;
 * the one whose rows are shortest simply fits more before it scrolls.
 *
 * A column with seven rows or fewer contributes nothing: this is a ceiling, not
 * a floor, and a demo with two orders should not open on two screens of blank
 * card.
 *
 * The measurement adds `scrollTop`, which is what makes it survive its own cap:
 * without it the first applied cap would move the rows it was measured from and
 * the next pass would read a different number.
 */
function useRowCappedPanels(): [PanelCap, PanelCap, PanelCap] {
  const bodies = useRef<Array<HTMLDivElement | null>>([]);
  const [bodyMaxHeight, setBodyMaxHeight] = useState<number | null>(null);

  useEffect(() => {
    let frame: number | null = null;

    const measure = () => {
      frame = null;
      let next: number | null = null;
      for (const el of bodies.current) {
        if (!el) continue;
        // The first row that must NOT be visible. Absent, the column fits and
        // has no opinion about the height.
        const overflowing = el.querySelectorAll<HTMLElement>("[data-order-row]")[PANEL_ROWS];
        if (!overflowing) continue;
        const h =
          overflowing.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        next = Math.max(next ?? 0, Math.round(h));
      }
      // Sub-pixel churn would re-render all three columns on every poll.
      setBodyMaxHeight((prev) => (prev != null && next != null && Math.abs(prev - next) < 1 ? prev : next));
    };
    const schedule = () => { if (frame == null) frame = requestAnimationFrame(measure); };

    // Rows change size (a card opens, a label wraps) and rows come and go, so
    // both are watched. The resize observer is re-pointed only from a DOM
    // mutation, never from its own callback: re-observing always re-fires the
    // initial size, and a callback that re-observes is a loop.
    const ro = new ResizeObserver(schedule);
    const attach = () => {
      ro.disconnect();
      for (const el of bodies.current) {
        if (!el) continue;
        ro.observe(el);
        el.querySelectorAll<HTMLElement>("[data-order-row]").forEach((row) => ro.observe(row));
      }
    };
    const mo = new MutationObserver(() => { attach(); schedule(); });
    for (const el of bodies.current) if (el) mo.observe(el, { childList: true, subtree: true });

    attach();
    measure();
    return () => {
      ro.disconnect();
      mo.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, []);

  // Memoised so the bodies are not detached and re-attached on every poll: the
  // caps only change identity when the measured height itself moves.
  return useMemo(() => {
    const column = (i: number): PanelCap => ({
      bodyRef: (el: HTMLDivElement | null) => { bodies.current[i] = el; },
      bodyMaxHeight,
    });
    return [column(0), column(1), column(2)];
  }, [bodyMaxHeight]);
}

/* ── order primitives ─────────────────────────────────────────────────────── */

function Tracker({ status }: { status: string }) {
  const cur = STAGE_OF[status] ?? -1;
  const branched = status === "dispute" || status.startsWith("refund");
  return (
    <div className="flex items-center gap-1">
      {STAGES.map((s, i) => (
        <div key={s} className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn("h-1 rounded-full", i <= cur ? "bg-primary" : "bg-border")} />
          <span className={cn("truncate text-sm", i <= cur ? "text-foreground" : "text-muted-foreground")}>{s}</span>
        </div>
      ))}
      {branched && <ToneBadge tone="danger" className="ml-1">disputed</ToneBadge>}
    </div>
  );
}

function TxList({ view }: { view: OrderView }) {
  if (!view.payments.length) return null;
  return (
    <>
      <Separator />
      {/* The only 12px left inside the order cards: a hash is a reference to
          copy or click, not something anyone reads. */}
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {view.payments.map((p, i) => (
          <li key={i} className="flex items-baseline gap-1.5">
            <span className="font-mono text-muted-foreground">{p.kind}</span>
            {p.txHash && p.txHash.length > 20 ? (
              <a href={txUrl(p.chain, p.txHash)} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 font-mono text-primary underline-offset-4 hover:underline">
                {shortHash(p.txHash)}
                <RiExternalLinkLine className="size-3" />
              </a>
            ) : (
              <span className="text-muted-foreground">{p.status}</span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Balances as one wrapping row of chips rather than a grid of `Metric` tiles.
 *
 * Five figures in a three-wide grid cost two rows plus a card header — well over
 * a hundred pixels of the Buyer panel spent on numbers that are reference, not
 * action, and spent directly above the pay button. The chips carry the same
 * five figures in a single row.
 */
function BalanceStrip({ title, sub, muted, items }: {
  title: string;
  sub?: React.ReactNode;
  muted?: boolean;
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <div className={cn("space-y-1.5", muted && "opacity-70")}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</span>
        {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <span key={i.label} className="inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-xs">
            <span className="text-muted-foreground">{i.label}</span>
            <span className="font-semibold tabular-nums">{i.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * States in which an order is pure history: nothing left to do, nothing left to
 * watch. These are the ones that open collapsed, so a panel with a dozen settled
 * orders behind it still opens on the one order that needs something.
 *
 * `expired` is NOT here even though it is terminal — it still carries a "Close
 * order" button, and a control nobody can see is a control nobody presses.
 */
const AT_REST = new Set(["completed", "refunded", "failed"]);

/**
 * Card wrapper shared by every order row across the panels, foldable per order.
 *
 * Collapsed it is a single line — emoji, name, amount, status — the same shape
 * the host panel's "All orders" list has always had; expanded it shows the
 * tracker, the controls and the full transaction list. The fold is per order
 * rather than per panel because the panels mix two kinds of row: one order
 * waiting on the user, and every order that already finished. A whole-list fold
 * makes those share a fate, which is the wrong unit.
 *
 * `defaultOpen` is read once, at mount. That is deliberate: an order the user
 * watches through checkout stays open as its status advances into `completed`,
 * while the settled orders already on screen at first paint start folded.
 */
function OrderCard({ v, busy, sub, defaultOpen, children }: {
  v: OrderView; busy: boolean; sub?: React.ReactNode; defaultOpen?: boolean; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? !AT_REST.has(v.status));
  const foldable = children != null;
  return (
    // `overflow-visible` is load-bearing, not cosmetic — see STICKY_ACTION.
    // `data-order-row` is what useRowCappedPanels counts; every per-order row in
    // a column carries it, cards and the host's compact history lines alike.
    <Card className="overflow-visible" data-order-row>
      <CardHeader>
        {/* A card inside a panel, so it sits a step below the panel heading. */}
        <CardTitle className="flex items-center gap-2 text-sm">
          {foldable ? (
            <button
              type="button"
              onClick={() => setOpen((s) => !s)}
              aria-expanded={open}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            >
              <RiArrowDownSLine
                className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
              />
              <span className="text-lg leading-none">{v.product?.emoji ?? "📦"}</span>
              <span className="truncate">{v.product?.name ?? "Order"}</span>
            </button>
          ) : (
            <>
              <span className="text-lg leading-none">{v.product?.emoji ?? "📦"}</span>
              <span className="truncate">{v.product?.name ?? "Order"}</span>
            </>
          )}
        </CardTitle>
        {/* Indented to clear the chevron, so the two lines read as one block. */}
        <CardDescription className={cn("truncate", foldable && "pl-6")}>{sub}</CardDescription>
        <CardAction>
          <StatusBadge status={v.status} label={v.statusLabel} busy={busy} />
        </CardAction>
      </CardHeader>
      {foldable && open && <CardContent className="space-y-3">{children}</CardContent>}
    </Card>
  );
}

/**
 * The rail chooser, as a stock RadioGroup. Availability rides along as the
 * label's secondary line rather than as a colour.
 *
 * The `note` shows for the SELECTED rail only. Three rails each explaining
 * themselves is three lines of prose about two rails the buyer is not taking,
 * and it pushed the pay button down by roughly its own height.
 */
function RailChooser({ name, rails, value, onChange, disabled, need }: {
  name: string;
  rails: Array<{ id: PaySource; label: string; avail: number; fee?: number; note: string; disabled?: boolean }>;
  value: PaySource;
  onChange: (id: PaySource) => void;
  disabled?: boolean;
  need: number;
}) {
  return (
    <RadioGroup className="gap-2.5" value={value} onValueChange={(v) => onChange(v as PaySource)} disabled={disabled}>
      {rails.map((r) => {
        const enough = r.avail >= need + (r.fee ?? 0);
        const id = `${name}-${r.id}`;
        return (
          <div key={r.id} className="flex items-start gap-3">
            <RadioGroupItem value={r.id} id={id} disabled={r.disabled} className="mt-1" />
            <Label htmlFor={id} className="flex min-w-0 flex-1 items-start gap-2 font-normal">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.label}</span>
                {value === r.id && (
                  <span className="block truncate text-xs text-muted-foreground">{r.note}</span>
                )}
              </span>
              <span className={cn("shrink-0 tabular-nums", enough ? "text-foreground" : "text-destructive")}>
                {r.avail.toFixed(2)}
              </span>
            </Label>
          </div>
        );
      })}
    </RadioGroup>
  );
}

/**
 * Which chain the cross-chain rails start from.
 *
 * Only shown once a cross-chain rail is selected: on the `arc` rail nothing
 * leaves Arc, so a source chain would be a control with no effect. The USDC
 * figure beside each chain is that chain's own balance — for the bridge rail it
 * is what will be burned, and for Gateway it is what a top-up could deposit.
 */
function SourceChainPicker({ value, onChange, usdcByChain, disabled }: {
  value: SourceChainId;
  onChange: (id: SourceChainId) => void;
  usdcByChain: Partial<Record<SourceChainId, string>> | null;
  disabled?: boolean;
}) {
  // One line rather than one paragraph per unavailable chain: the toggle already
  // shows which chains are out by refusing to be picked, and this says why.
  const unavailable = SOURCE_CHAINS.filter((c) => c.disabledReason);
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium tracking-wide text-muted-foreground uppercase">from chain</span>
      <ToggleGroup variant="outline" size="sm" className="flex-wrap"
        value={[value]} onValueChange={([v]) => v && onChange(v as SourceChainId)} disabled={disabled}>
        {SOURCE_CHAINS.map((c) => (
          // A disabled chain stays visible with its balance, but cannot be
          // picked — the title carries the reason, so the control explains
          // itself instead of just refusing.
          <ToggleGroupItem key={c.key} value={c.key} disabled={Boolean(c.disabledReason)} title={c.disabledReason}>
            {c.label}
            <span className="tabular-nums text-muted-foreground">{usd(usdcByChain?.[c.key] ?? null)}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">
        {sourceChain(value).finality} · gas paid in {sourceChain(value).nativeCurrency.symbol}
        {unavailable.map((c) => ` · ${c.label} unavailable (${c.disabledReason})`).join("")}
      </p>
    </div>
  );
}

/* ── board ────────────────────────────────────────────────────────────────── */

export default function Marketplace({ initial, demoBuyer }: {
  /** Rendered on the server, so the board is populated on first paint. */
  initial: BoardSnapshot;
  demoBuyer: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const { address, isConnected } = useAccount();
  const { arcUsdc: walletUsdc, refresh: refreshWallet } = useWalletBalance();

  // Two-wallet mode: buyer and seller are different addresses the user actually
  // controls. The seller only RECEIVES, so it needs no signature — which is why
  // a second account from the same wallet is enough to play the part honestly.
  // Shared with /app/withdraw, which reads the same address's EURC balance.
  const { sellerWallet, pick: pickSeller, candidates: sellerCandidates } = useSellerWallet();
  // A second wallet for the seller is OPTIONAL. Without one the settlement
  // wallet keeps the floored EURC, exactly as in the no-wallet flow — the buyer
  // leg is unaffected, so it must never block checkout.

  // An expired order is finished — polling it would keep the board busy forever
  // over something that can no longer change. `null` is not "stop reading": the
  // board still refreshes on demand, it just has no reason to do so on a timer.
  const [board, setBoard] = useState<BoardSnapshot>(initial);
  const liveWork = board.views.some((v) =>
    v.status !== "expired"
    && (v.state.endsWith("_pending") || v.status === "processing_payment" || v.status === "refunding"));
  const { data, error: boardError, refresh: refreshBoard } =
    useLive<BoardSnapshot>("/api/board", initial, liveWork || pending ? 4000 : null);
  useEffect(() => { if (data) setBoard(data); }, [data]);

  const views = board.views;
  const bal = board.balances;

  /**
   * Read the rail again for orders that are waiting on it.
   *
   * OUT of the board poll on purpose. It used to run inside it, sequentially,
   * once per `payout_pending` order — so a four-second tick carried a CPN API
   * call per pending payout and the whole board waited for them. It belongs on
   * its own clock: CPN reports in minutes, not seconds.
   *
   * A bank order stops at `payout_pending` until someone asks, because CPN's
   * submit returns BEFORE the Arc tx is mined and the payout row is born without
   * a hash. Nothing else in the browser would ever ask.
   */
  const pendingPayouts = views.filter((v) => v.state === "payout_pending").map((v) => v.id).join(",");
  useEffect(() => {
    if (!pendingPayouts) return;
    const sweep = async () => {
      for (const id of pendingPayouts.split(",")) await mpRefreshPayout(id).catch(() => undefined);
      refreshBoard();
    };
    void sweep();
    const id = setInterval(() => void sweep(), 20_000);
    return () => clearInterval(id);
  }, [pendingPayouts, refreshBoard]);

  const refresh = () => { refreshBoard(); refreshWallet(); };

  const run: RunFn = (id, fn, label) =>
    start(async () => {
      setBusyId(id);
      // The toast is the only feedback for the long ones — a bridge or a bank
      // release can run past a minute with nothing else moving on screen.
      const r = label ? await withActionToast(label, fn) : await fn();
      if (!r.ok && "error" in r) setError(r.error ?? "failed");
      // Freed BEFORE the re-read, not after. The toast closes when the action
      // settles, and the button used to stay dead through a full board reload
      // after that — so the screen said "done" while nothing was clickable,
      // which reads as the click having been lost. The re-read still happens;
      // it just no longer holds the UI hostage.
      setBusyId(null);
      refresh();
    });
  const busy = (id: string) => pending && busyId === id;

  // One cap for all three role columns, read off whichever of them has the
  // tallest first PANEL_ROWS rows.
  const caps = useRowCappedPanels();

  return (
    <>
      <div className="flex min-h-0 flex-col gap-3">
        <Storefront pending={pending} payer={isConnected ? address ?? null : null}
          hints={board.hints} bankEnabled={board.payout.enabled}
          onBuy={(id, payoutTo) =>
            run(
              null,
              () => mpCheckout(id, isConnected ? address : undefined, sellerWallet ?? undefined, payoutTo),
              payoutTo === "bank" ? "Creating bank-bound order (screening + rail quote)" : "Creating order (screening + FX quote)",
            )} />

        {/* Three roles only — the seller's fiat exits live on /app/withdraw.
            The grid stretches its items by default, so pinning every body to
            the same measured height is all it takes for the columns to end
            level — no equal-height JS beyond the cap itself. */}
        <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <BuyerPanel views={views} bal={bal} pending={pending} busy={busy} run={run}
            connectedAddress={isConnected ? address ?? null : null} walletUsdc={walletUsdc}
            demoBuyer={demoBuyer} cap={caps[0]} />
          {/* Buyer → Host → Seller: the host sits between the two parties it
              arbitrates, and the money moves left to right. */}
          <HostPanel views={views} busy={busy} run={run} cap={caps[1]} relay={board.relay} />
          <SellerPanel views={views} busy={busy} run={run}
            sellerWallet={sellerWallet} candidates={sellerCandidates} onPick={pickSeller}
            cap={caps[2]} />
        </div>
      </div>

      {/* An action's failure outranks a poll's: the poll will try again in four
          seconds and says nothing the user did, while a failed action is the
          answer to something they just pressed. */}
      {(error ?? boardError) && (
        <div className="fixed inset-x-0 bottom-4 z-50 mx-auto w-fit max-w-[90vw] px-4">
          <Alert variant="destructive" className="shadow-lg">
            <RiErrorWarningLine />
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription className="truncate">{error ?? boardError}</AlertDescription>
            <AlertAction>
              <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => setError(null)}>
                <RiCloseLine />
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )}
    </>
  );
}

/** `label` opts the action into a progress toast; omit it for instant ones. */
type RunFn = (
  id: string | null,
  fn: () => Promise<{ ok: boolean; error?: string }>,
  label?: string,
) => void;

/* ── storefront strip ─────────────────────────────────────────────────────── */

/**
 * The catalog sits above the role columns, not inside Buyer: it is the entry
 * point of the whole demo and keeps the four columns evenly tall.
 */
function Storefront({ pending, payer, hints, bankEnabled, onBuy }: {
  pending: boolean; payer: string | null;
  /** Both arrive with the board — they used to be two more requests on mount. */
  hints: PriceHint[]; bankEnabled: boolean;
  onBuy: (productId: string, payoutTo: "wallet" | "bank") => void;
}) {
  const hintFor = (id: string) => hints.find((h) => h.productId === id);

  return (
    <Card className="shrink-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-bold">
          <RiShoppingCartLine className="size-4 text-muted-foreground" />
          Storefront
        </CardTitle>
        <CardDescription>
          {payer
            ? <>New orders are payable by your wallet <span className="font-mono">{shortAddr(payer)}</span> — you sign every leg yourself.</>
            : "No wallet connected — orders are paid by the demo buyer, whose key the server holds."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {CATALOG.map((p) => {
            const hint = hintFor(p.id);
            // Price picks the destination; the buyer is never asked. Below the
            // corridor minimum a bank order is refused at createOrder, so the
            // only honest offer on a cheap listing is the wallet one. With no
            // rail configured at all, everything settles to a wallet.
            const toBank = bankEnabled && canPayoutToBank(p);
            return (
              // Stock Card, only tightened: six listings sit above the role
              // columns, so the strip keeps the default 6-unit rhythm halved.
              <Card key={p.id} className="gap-3 py-4">
                <CardHeader className="gap-1 px-4">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <span className="text-base leading-none">{p.emoji}</span>
                    <span className="truncate">{p.name}</span>
                  </CardTitle>
                  <CardDescription className="truncate text-sm">{p.seller}</CardDescription>
                  <CardAction>
                    <Badge variant="secondary" className="tabular-nums">{fmtEUR(p.priceEURMinor)}</Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="px-4">
                  {/* The euro figure is the GUARANTEE; the USDC one is what the
                      buyer pays and is only ever approximate here — the binding
                      number is quoted at checkout, and it differs by destination. */}
                  <p className="text-sm text-muted-foreground">
                    Seller is guaranteed <span className="font-medium text-foreground">{fmtEUR(p.priceEURMinor)}</span>
                    {(toBank ? hint?.bankUsdc : hint?.walletUsdc) && (
                      <> · you pay ≈ {usd(toBank ? hint!.bankUsdc : hint!.walletUsdc)} USDC</>
                    )}
                  </p>
                </CardContent>
                <CardFooter className="flex-col items-stretch gap-1.5 px-4">
                  {/* One button, and its label names the destination the price
                      already chose — the buyer should never have to work out
                      why the same wording settled two different ways. */}
                  <Button size="sm" variant={toBank ? "default" : "outline"} disabled={pending}
                    onClick={() => onBuy(p.id, toBank ? "bank" : "wallet")}>
                    {toBank ? <><RiBankLine /> BUY → EURO FIAT</> : <>BUY → EURC</>}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── 1. Buyer — storefront + own orders ───────────────────────────────────── */

function BuyerPanel({ views, bal, pending, busy, run, connectedAddress, walletUsdc, demoBuyer, cap }: {
  views: OrderView[]; bal: Balances | null; pending: boolean; busy: (id: string) => boolean; run: RunFn;
  connectedAddress: string | null; walletUsdc: string | null; demoBuyer: string | null; cap: PanelCap;
}) {
  const [rail, setRail] = useState<Record<string, PaySource>>({});
  // Per order, because two orders can sensibly be funded from two chains — the
  // buyer holds USDC where they hold it.
  const [srcChain, setSrcChain] = useState<Record<string, SourceChainId>>({});
  const [disputeFor, setDisputeFor] = useState<string | null>(null);
  const [reason, setReason] = useState("Item not as described");
  const [showDemo, setShowDemo] = useState(false);
  const { signTypedDataAsync } = useSignTypedData();
  const { connector, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  // The connected wallet's own funding sources, read the same way the demo
  // buyer's are — Arc from the server, the source chain from the server, Gateway
  // from the wallet itself (the balance is keyed to the depositor, so only it can ask).
  const [gwUsdc, setGwUsdc] = useState<string | null>(null);
  const [srcUsdc, setSrcUsdc] = useState<Record<SourceChainId, string> | null>(null);
  const [railBusy, setRailBusy] = useState<string | null>(null);

  const getProvider = async (): Promise<Eip1193 | null> =>
    ((await connector?.getProvider?.()) as Eip1193 | undefined) ?? null;

  const loadWalletRails = async (address: string) => {
    // Once per connect, not on a timer: this is four more reads against public
    // RPCs that rate-limit, and only the rail selector below looks at them.
    void getJson<{ srcUsdc: Record<SourceChainId, string> | null }>(
      `/api/wallet?address=${address}&fields=src`,
    ).then((r) => setSrcUsdc(r.ok ? r.srcUsdc : null));
    try {
      const provider = await getProvider();
      if (!provider) return;
      setGwUsdc((await (await rails()).walletGatewayBalance(provider)).confirmedMinor);
    } catch {
      setGwUsdc(null); // Gateway unreachable or wallet on an unsupported chain
    }
  };

  useEffect(() => {
    if (!connectedAddress) { rails().then((m) => m.resetWalletRails()); setGwUsdc(null); setSrcUsdc(null); return; }
    loadWalletRails(connectedAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedAddress, connector]);

  const same = (a: string, b: string | null) => b != null && a.toLowerCase() === b.toLowerCase();
  // Who can actually sign for this order: the connected wallet, or the demo
  // buyer whose key the server holds. Anything else can only be watched.
  const isMine = (v: OrderView) => same(v.payer, connectedAddress);
  // The server-signed buyer is switched OFF while a wallet is connected: with a
  // real payer present, a one-click server payment would quietly settle an order
  // the user meant to sign themselves.
  const isDemo = (v: OrderView) => !connectedAddress && same(v.payer, demoBuyer);

  // With a wallet connected the demo buyer is someone else's account — keep it
  // out of the way unless explicitly asked for.
  const demoOrders = connectedAddress ? views.filter((v) => !isMine(v)) : [];
  const shown = connectedAddress && !showDemo ? views.filter(isMine) : views;

  // The same three rails the demo buyer has, drawn from THIS wallet's balances
  // and from whichever source chain the order has selected.
  const myRailsFor = (from: SourceChainId): Array<{
    id: PaySource; label: string; avail: number; fee?: number; note: string;
  }> => {
    const c = sourceChain(from);
    return [
      { id: "arc", label: "USDC on Arc", avail: num(walletUsdc), note: "direct, no gas" },
      { id: "unified", label: "Unified Balance", avail: num(gwUsdc), fee: 1, note: `Gateway spend → Arc, sub-second · draws from ${c.label}` },
      {
        id: "bridge", label: `${c.label} bridge`, avail: num(srcUsdc?.[from] ?? null),
        note: `CCTP · ${c.finality} · needs ${c.nativeCurrency.symbol} for gas`,
      },
    ];
  };
  const railEnough = (rails: ReturnType<typeof myRailsFor>, id: PaySource, need: number) => {
    const r = rails.find((x) => x.id === id);
    return r != null && r.avail >= need + (r.fee ?? 0);
  };
  // Gateway charges its spend fee out of the unified balance, so a top-up has
  // to cover the order AND the fee or the rail stays unusable. Chain-independent.
  const unifiedFee = 1;
  const unifiedFeeMinor = BigInt(Math.round(unifiedFee * 1e6));

  // Connected-wallet pay: fetch the ERC-3009 typed data, sign it in the browser
  // wallet, and hand the signature back for the operator to relay (gasless).
  const signAndAuthorize = async (v: OrderView): Promise<{ ok: boolean; error?: string }> => {
    const td = await mpAuthTypedData(v.id);
    if (!td.ok) return { ok: false, error: td.error };
    const m = td.typedData;

    // The ERC-3009 domain is Arc's, and a wallet refuses to sign typed data for
    // a chain it is not on — without prompting. Paying with USDC already on Arc
    // moves no funds across chains, so nothing else in this path would ever ask
    // the wallet to switch, and the refusal arrives looking like a declined
    // signature. Ask for the network first, and let the wallet prompt.
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
    return mpPaySigned(v.id, signature);
  };

  /**
   * Pay one of my own orders. Same three rails the demo buyer has, only every
   * leg is signed by this wallet: bring the USDC to my address on Arc, then sign
   * the ERC-3009 so the operator can pull it into escrow (gasless).
   */
  const payFromWallet = (v: OrderView, source: PaySource, from: SourceChainId) =>
    run(v.id, async () => {
      const c = sourceChain(from);
      // Each leg gets its own line: the wallet prompts twice on a cross-chain
      // rail, and "still working" has to distinguish the ~8s attestation wait
      // from the signature it is about to ask for.
      if (source !== "arc") {
        const provider = await getProvider();
        if (!provider || !connectedAddress) return { ok: false, error: "Wallet provider unavailable" };
        const amt = await mpOrderAmount(v.id);
        if (!amt) return { ok: false, error: "order amount not found" };
        try {
          const txHash = await withToast(
            source === "unified"
              ? `Gateway spend → Arc (sub-second once confirmed), drawn from ${c.label}`
              : `Bridging from ${c.label} — approve, burn, ${c.finality}, mint on Arc`,
            () => source === "unified"
              ? (rails()).then((m) => m.walletSpendToArc(provider, { amountMinor: BigInt(amt), recipient: connectedAddress, from }))
              : (rails()).then((m) => m.walletBridgeToArc(provider, BigInt(amt), from)),
          );
          // Only now: the burn landed and the mint returned, so the order is
          // genuinely mid-funding. Marking it before the attempt is what used to
          // freeze a failed order at "Processing payment…" with nothing moved.
          await mpMarkFunding(v.id);
          await mpRecordWalletFunding(v.id, source === "unified" ? "gw-spend" : "bridge", txHash);
        } catch (e) {
          // A failure that already burned must NOT look payable — retrying would
          // move a second amount. Everything else leaves the order in `created`,
          // where its pay control is still on screen and a retry is safe.
          if (fundsMayBeInFlight(e)) await mpMarkFunding(v.id);
          // A declined switch/add-chain prompt is the user's answer, not a
          // fault: its own message already says what to approve, and wrapping
          // it in "… failed:" would report a decision as a crash.
          if ((e as { code?: string })?.code === "WALLET_CHAIN_REJECTED") {
            return { ok: false, error: String((e as Error).message) };
          }
          return { ok: false, error: `${source === "unified" ? "Gateway spend" : "Bridge"} failed: ${walletErrorMessage(e, "declined in wallet")}` };
        }
        if (connectedAddress) await loadWalletRails(connectedAddress);
      }
      return signAndAuthorize(v);
    });

  /** Top up the wallet's Gateway balance from the chosen source chain so the unified rail is usable. */
  const depositToGateway = async (amountMinor: bigint, from: SourceChainId) => {
    const provider = await getProvider();
    if (!provider || !connectedAddress) return;
    setRailBusy("deposit");
    try {
      await withToast(
        `Depositing into Gateway from ${sourceChain(from).label} — spendable only after that chain finalises`,
        () => rails().then((m) => m.walletGatewayDeposit(provider, amountMinor, from)),
      );
      await loadWalletRails(connectedAddress);
    } catch {
      /* surfaced by the balance staying put — Gateway credits only after finality */
    }
    setRailBusy(null);
  };

  return (
    <Panel title="Buyer" hint="Shop and pay in USDC from any chain" icon={<RiShoppingCartLine className="size-4" />}
      {...cap}>
      {/* Two distinct accounts, deliberately: the connected browser wallet pays for
          its own orders, the server-signed demo buyer pays for the rest. */}
      {connectedAddress && (
        <BalanceStrip
          title="My wallet · USDC"
          sub={<span className="font-mono">{shortAddr(connectedAddress)}</span>}
          items={[
            { label: "Arc", value: usd(walletUsdc) },
            { label: "Gateway", value: usd(gwUsdc) },
            ...SOURCE_CHAINS.map((c) => ({ label: c.label, value: usd(srcUsdc?.[c.key] ?? null) })),
          ]}
        />
      )}
      {(!connectedAddress || showDemo) && (
        <BalanceStrip
          title="Demo buyer · server-signed"
          muted={Boolean(connectedAddress)}
          sub={connectedAddress ? "disabled while your wallet is connected — reference only" : undefined}
          items={[
            { label: "Arc", value: usd(bal?.buyerArcUsdc) },
            { label: "Gateway", value: usd(bal?.buyerGatewayUsdc) },
            ...SOURCE_CHAINS.map((c) => ({ label: c.label, value: usd(bal?.buyerSrcUsdc?.[c.key] ?? null) })),
          ]}
        />
      )}

      {/* One line, not an Alert: this is orientation the buyer reads once, and
          it was costing four times its own weight directly above the button. The
          rails it used to enumerate are listed by the rail chooser itself. */}
      {connectedAddress && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">You are the payer</span> — new orders use your address and
          every rail runs from your own wallet. The escrow authorization stays gasless; the operator pays that gas.
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        {/* Hand-rolled rather than `SectionLabel` because of the toggle on the
            right, but it has to read as the same divider — keep them in step. */}
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">My orders</span>
        {shown.length > 0 && <Badge variant="secondary" className="tabular-nums">{shown.length}</Badge>}
        <Separator className="flex-1" />
        {connectedAddress && demoOrders.length > 0 && (
          <Button size="xs" variant="ghost" onClick={() => setShowDemo((s) => !s)}>
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
        const from = srcChain[v.id] ?? DEFAULT_SOURCE_CHAIN_ID;
        const myRails = myRailsFor(from);
        const mine = isMine(v);
        const payableByServer = isDemo(v);
        // An order stuck at `funding_pending` splits in two, and the split is
        // what decides whether retrying is safe.
        //
        //   funding leg recorded → the USDC is ON ARC and only the ERC-3009
        //     signature is missing. Re-signing is idempotent (the escrow checks
        //     `hasCollectedPayment` first), so this is safe outright.
        //   no funding leg → either a rail failed before it burned, or one
        //     burned and never minted. Indistinguishable from here, so the
        //     controls come back behind a warning that names the risk. The
        //     alternative is an order nothing on screen can reach.
        const stalled = v.status === "processing_payment";
        const fundingLanded = v.payments.some((p) => p.kind === "funding");
        // `expired` outranks both: past `preApprovalExpiry` the escrow refuses
        // the collection, so every payment control below would offer a
        // transaction that reverts — which is exactly the ESTIMATION_ERROR this
        // check exists to stop being reachable.
        const expired = v.status === "expired";
        const payable = v.status === "waiting_payment" || (stalled && !fundingLanded);
        return (
          <OrderCard key={v.id} v={v} busy={busy(v.id)}
            sub={`${fmtEUR(v.priceEURMinor)} · pay ${usd(v.usdcAmount)} USDC`}>
            <Tracker status={v.status} />

            {expired && (
              <Alert variant="destructive">
                <RiErrorWarningLine />
                <AlertTitle>Authorization window closed</AlertTitle>
                <AlertDescription>
                  The ERC-3009 authorization for this order expired{" "}
                  <span className="font-medium text-foreground">
                    {new Date(v.preApprovalExpiry).toLocaleString()}
                  </span>{" "}
                  — one hour after checkout. The escrow now refuses to collect, so paying it is no longer possible;
                  that refusal is what an <span className="font-mono">ESTIMATION_ERROR</span> from the relay means.
                  {fundingLanded && <> Nothing was taken from you: the USDC a rail already delivered is sitting in
                    your own address on Arc, and the fastest listing pays from there.</>}
                </AlertDescription>
                <AlertAction>
                  <Button size="xs" variant="outline" disabled={pending || busy(v.id)}
                    onClick={() => run(v.id, () => mpExpireOrder(v.id), "Closing the expired order")}>
                    Close order
                  </Button>
                </AlertAction>
              </Alert>
            )}

            {!expired && stalled && !fundingLanded && (
              <Alert variant="destructive">
                <RiErrorWarningLine />
                <AlertTitle>Funding never completed</AlertTitle>
                <AlertDescription>
                  This order was marked as paying but no funding transaction was recorded. If the last attempt failed
                  before your wallet signed anything, paying again is safe. If a cross-chain transfer did burn, the
                  USDC is still in flight — <span className="font-medium text-foreground">wait for it</span> rather
                  than sending a second one, or pay with USDC already on Arc.
                </AlertDescription>
              </Alert>
            )}

            {!expired && stalled && fundingLanded && (mine || payableByServer) && (
              <Alert>
                <AlertTitle>Authorization missing</AlertTitle>
                <AlertDescription>
                  The USDC reached Arc — only the escrow authorization is left. Signing again is safe; the escrow
                  ignores a payment it has already collected.
                </AlertDescription>
                <AlertAction>
                  <Button size="xs" disabled={pending || busy(v.id)}
                    onClick={() => mine
                      ? payFromWallet(v, "arc", from)
                      : run(v.id, () => mpPay(v.id, "arc"), "Authorizing into escrow")}>
                    Finish payment
                  </Button>
                </AlertAction>
              </Alert>
            )}

            {payable && mine && (
              <Card size="sm" className="overflow-visible">
                <CardHeader>
                  <CardTitle className="flex items-center gap-1.5 text-sm">
                    <RiEditLine className="size-3.5" />{stalled ? "Retry payment" : "Pay from my wallet"}
                  </CardTitle>
                  <CardDescription>needs {usd(v.usdcAmount)} USDC on Arc</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <RailChooser name={`my-${v.id}`} rails={myRails} value={sel} need={need} disabled={pending}
                    onChange={(id) => setRail((s) => ({ ...s, [v.id]: id }))} />
                  {sel !== "arc" && (
                    <SourceChainPicker value={from} usdcByChain={srcUsdc} disabled={pending}
                      onChange={(id) => setSrcChain((s) => ({ ...s, [v.id]: id }))} />
                  )}
                  {/* What the chosen rail will actually do. It sits ABOVE the
                      footer on purpose: the footer is pinned, and prose pinned
                      to the screen edge is prose in the way. */}
                  <p className="text-xs text-muted-foreground">
                    {sel === "arc"
                      ? "One ERC-3009 signature — no gas."
                      : sel === "unified"
                        ? `Gateway spend → Arc (sub-second) drawn from ${sourceChain(from).label}, then one ERC-3009 signature.`
                        : `CCTP from ${sourceChain(from).label} — approve + burn (needs ${sourceChain(from).nativeCurrency.symbol} for gas), ${sourceChain(from).finality}, mint on Arc, then one ERC-3009 signature.`}
                  </p>
                </CardContent>
                <CardFooter className={STICKY_ACTION}>
                  {/*
                   * Only when the unified rail is the one selected AND short:
                   * offering a Gateway top-up next to "Pay via USDC on Arc"
                   * invites the buyer to move money for a rail they are not
                   * using. The amount includes Gateway's own spend fee — a
                   * deposit of exactly the order amount leaves the rail one fee
                   * short and the Pay button still refusing. The deposit goes in
                   * from the SAME chain the spend will draw down, or Gateway
                   * would report the balance as insufficient against an
                   * allocation that has nothing behind it.
                   */}
                  {sel === "unified" && num(gwUsdc) < need + unifiedFee
                    && num(srcUsdc?.[from] ?? null) >= need + unifiedFee && (
                    <Button size="sm" variant="outline" disabled={railBusy !== null || pending}
                      onClick={() => depositToGateway(BigInt(v.usdcAmount ?? "0") + unifiedFeeMinor, from)}>
                      {railBusy === "deposit"
                        ? "Depositing into Gateway…"
                        : `Deposit ${(need + unifiedFee).toFixed(2)} USDC into Gateway (from ${sourceChain(from).label})`}
                    </Button>
                  )}
                  <Button size="sm" disabled={pending || !railEnough(myRails, sel, need)}
                    onClick={() => payFromWallet(v, sel, from)}>
                    {railEnough(myRails, sel, need)
                      ? `Pay via ${myRails.find((r) => r.id === sel)?.label}`
                      : `Not enough ${myRails.find((r) => r.id === sel)?.label}`}
                  </Button>
                </CardFooter>
              </Card>
            )}

            {payable && !mine && !payableByServer && (
              <Alert>
                <AlertDescription>
                  {same(v.payer, demoBuyer)
                    ? <>Left over from the demo buyer. The server-signed buyer is disabled while your wallet is
                      connected — disconnect to pay it, or leave it be.</>
                    : <>This order belongs to <span className="font-mono text-foreground">{shortAddr(v.payer)}</span> —
                      only that wallet can sign its ERC-3009. Connect it to pay.</>}
                </AlertDescription>
              </Alert>
            )}

            {payable && !mine && payableByServer && (
              <Card size="sm" className="overflow-visible">
                <CardHeader>
                  <CardTitle className="text-sm">Pay with USDC from (demo buyer)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <RailChooser name={`demo-${v.id}`} value={sel} need={need} disabled={pending}
                    rails={railsFor(from).map((r) => {
                      const avail = bal ? r.bal(bal) : 0;
                      return {
                        id: r.id, label: r.label, note: r.note, avail,
                        ...(r.fee != null ? { fee: r.fee } : {}),
                        disabled: avail < need + (r.fee ?? 0),
                      };
                    })}
                    onChange={(id) => setRail((s) => ({ ...s, [v.id]: id }))} />
                  {sel !== "arc" && (
                    <SourceChainPicker value={from} usdcByChain={bal?.buyerSrcUsdc ?? null} disabled={pending}
                      onChange={(id) => setSrcChain((s) => ({ ...s, [v.id]: id }))} />
                  )}
                </CardContent>
                <CardFooter className={STICKY_ACTION}>
                  <Button size="sm" className="w-full" disabled={pending}
                    onClick={() => run(v.id, () => mpPay(v.id, sel, from), `Paying via ${railsFor(from).find((r) => r.id === sel)?.label ?? sel}`)}>
                    Pay via {railsFor(from).find((r) => r.id === sel)?.label} (gasless)
                  </Button>
                </CardFooter>
              </Card>
            )}

            {v.shippedResi && (
              <p className="text-sm text-muted-foreground">
                Tracking <span className="font-mono text-foreground">{v.shippedResi}</span>
              </p>
            )}
            {v.disputeReason && <p className="text-sm text-destructive">Dispute: {v.disputeReason}</p>}
            {v.status === "completed" && <p className="text-sm text-muted-foreground">Order complete.</p>}

            {(v.status === "shipped" || ["paid", "confirmed"].includes(v.status)) && (
              <div className="flex flex-wrap gap-2">
                {v.status === "shipped" && (
                  <Button size="xs" variant="outline" disabled={pending} onClick={() => run(v.id, () => mpConfirm(v.id), "Confirming receipt")}>
                    <RiCheckboxCircleLine />Order received
                  </Button>
                )}
                <Button size="xs" variant="outline" disabled={pending}
                  onClick={() => setDisputeFor(disputeFor === v.id ? null : v.id)}>
                  Raise dispute
                </Button>
              </div>
            )}
            {disputeFor === v.id && (
              <div className="flex gap-2">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} className="flex-1" />
                <Button size="sm" variant="destructive" disabled={pending}
                  onClick={() => { run(v.id, () => mpDispute(v.id, reason), "Raising dispute"); setDisputeFor(null); }}>
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

function SellerPanel({ views, busy, run, sellerWallet, candidates, onPick, cap }: {
  views: OrderView[]; busy: (id: string) => boolean; run: RunFn;
  sellerWallet: string | null; candidates: readonly string[];
  onPick: (a: string | null) => void; cap: PanelCap;
}) {
  const [resi, setResi] = useState<Record<string, string>>({});
  const relevant = views.filter((v) => v.state !== "created");
  return (
    <Panel title="Seller" hint="Incoming orders — guaranteed floored EURC on Arc" icon={<RiStore2Line className="size-4" />}
      {...cap}>
      {/* Always offered: the seller address can be pasted, so it no longer
          depends on a connected wallet having a second permitted account.
          A section header rather than a card — this is one optional setting,
          and a card shell around it cost more height than the setting itself. */}
      <div className="space-y-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Seller wallet · optional
          </span>
          <Separator className="flex-1" />
          {sellerWallet && (
            <Button size="xs" variant="ghost" onClick={() => onPick(null)}>Change</Button>
          )}
        </div>
        {sellerWallet
          ? <span className="block truncate font-mono text-sm">{shortAddr(sellerWallet)}</span>
          : <SellerWalletPicker candidates={candidates} onPick={onPick} />}
        <p className="text-xs text-muted-foreground">
          The seller only receives, so no signature is needed. Set an address and the floored EURC is forwarded
          there; leave it unset and the settlement wallet keeps it.
        </p>
      </div>
      <SectionLabel count={relevant.length}>Incoming orders</SectionLabel>
      {relevant.length === 0 && <Empty>No paid orders yet.</Empty>}
      {relevant.map((v) => (
        <OrderCard key={v.id} v={v} busy={busy(v.id)} sub={`guaranteed ${fmtEUR(v.priceEURMinor)} EURC`}>
          {v.status === "paid" && (
            <div className="flex gap-2">
              <Input value={resi[v.id] ?? "TRK-001"} onChange={(e) => setResi((s) => ({ ...s, [v.id]: e.target.value }))}
                className="w-32" aria-label="Tracking number" />
              <Button size="sm" variant="outline" disabled={busy(v.id)}
                onClick={() => run(v.id, () => mpShip(v.id, resi[v.id] ?? "TRK-001"), "Marking as shipped")}>
                <RiTruckLine />Mark as shipped
              </Button>
            </div>
          )}
          {v.status === "completed" && (
            <p className="text-sm text-muted-foreground">
              {v.sellerAddress
                ? `${fmtEUR(v.priceEURMinor)} EURC forwarded to ${shortAddr(v.sellerAddress)}.`
                : v.eurcOutMinor ? `Received ${fmtEUR(v.eurcOutMinor)} EURC on Arc.` : "EURC received on Arc."}
            </p>
          )}
          {["shipped", "confirmed"].includes(v.status) && (
            <p className="text-sm text-muted-foreground">Waiting on buyer confirmation / settlement.</p>
          )}
          {v.status.startsWith("refund") && <p className="text-sm text-muted-foreground">Refunded to the buyer.</p>}
          <TxList view={v} />
        </OrderCard>
      ))}
    </Panel>
  );
}

/* ── 3. Host — the authority ──────────────────────────────────────────────── */

function HostPanel({ views, busy, run, cap, relay }: {
  views: OrderView[]; busy: (id: string) => boolean; run: RunFn; cap: PanelCap;
  /** The operator's running cost, carried by the board rather than polled here. */
  relay: RelayView | null;
}) {
  // A clock, started after mount so the server and the client agree on the
  // first paint. Null until then, which reads as "window not yet known".
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /** Milliseconds left in `v`'s dispute window, or 0 once it has passed. */
  const windowLeft = (v: OrderView): number => {
    if (v.buyerConfirmed || !v.shippedAt || now == null) return v.buyerConfirmed ? 0 : DISPUTE_WINDOW_MS;
    const elapsed = now - new Date(v.shippedAt).getTime();
    return Number.isNaN(elapsed) ? 0 : Math.max(0, DISPUTE_WINDOW_MS - elapsed);
  };

  const active = views.filter((v) => v.state !== "created");
  // Confirmation ends the window immediately — the buyer has spoken. Without it,
  // the host still has authority but must wait, so "shipped" alone can never be
  // settled the instant the seller says so.
  const settleable = active.filter((v) => (v.status === "confirmed" || v.status === "shipped") && !v.disputeReason);
  const disputes = active.filter((v) => v.status === "dispute");

  // The relay is the host's running cost: the operator pays Arc gas (USDC) for
  // every escrow call, and the fee is what refills it. It rides along with the
  // board — it was a poll of its own, every thirty seconds, for a number that
  // moves only when the board does.
  const gasLow = relay?.gasUsdc != null && Number(relay.gasUsdc) < Number(relay.minGasUsdc);

  return (
    <Panel title="Host / Marketplace" hint="Only the host releases & refunds · 5% commission, illustrative"
      icon={<RiBankLine className="size-4" />} {...cap}>
      {/* Healthy, this is two numbers and a floor — the paragraph explaining how
          the fee works was standing costs, not news, and it ran every render.
          Below the floor it becomes an Alert again: there the prose IS the news,
          because new orders stop being accepted. */}
      {gasLow ? (
        <Alert variant="destructive">
          <RiErrorWarningLine />
          <AlertTitle>Operator gas below floor</AlertTitle>
          <AlertDescription>
            {relay?.gasUsdc} USDC left against a {relay?.minGasUsdc} USDC floor — new orders are REFUSED until the
            operator is topped up, so no buyer is stranded mid-flow.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <BalanceStrip
            title="Operator"
            items={[
              { label: "gas (Arc)", value: relay?.gasUsdc == null ? "—" : `${relay.gasUsdc} USDC` },
              { label: "fee", value: relay ? `${(relay.feeBps / 100).toFixed(2)}%` : "—" },
              { label: "stop floor", value: relay?.minGasUsdc == null ? "—" : `${relay.minGasUsdc} USDC` },
            ]}
          />
          {relay != null && relay.feeBps === 0 && (
            <p className="text-xs text-muted-foreground">
              Fee 0 — the operator subsidises all gas. Set <span className="font-mono">RIVO_FEE_BPS</span> to
              recover it.
            </p>
          )}
        </>
      )}

      {disputes.length > 0 && (
        <>
          <SectionLabel count={disputes.length}>Disputes</SectionLabel>
          {disputes.map((v) => (
            <Card key={v.id} data-order-row>
              <CardHeader>
                <CardTitle className="text-sm">
                  {v.product?.emoji} {v.product?.name} · {fmtEUR(v.priceEURMinor)}
                </CardTitle>
                <CardDescription>{v.disputeReason}</CardDescription>
              </CardHeader>
              <CardFooter className="gap-2">
                <Button size="xs" variant="destructive" disabled={busy(v.id)} onClick={() => run(v.id, () => mpRefund(v.id), "Refunding to buyer (bridge-back)")}>
                  {busy(v.id) ? "…" : "Approve refund"}
                </Button>
                <Button size="xs" variant="outline" disabled={busy(v.id)} onClick={() => run(v.id, () => mpRelease(v.id), releaseLabel(v))}>
                  Release to seller
                </Button>
              </CardFooter>
            </Card>
          ))}
        </>
      )}

      <SectionLabel count={settleable.length}>Ready to settle</SectionLabel>
      {settleable.length === 0 && <Empty>No orders waiting on settlement.</Empty>}
      {settleable.map((v) => {
        const price = num(v.priceEURMinor);
        const left = windowLeft(v);
        const held = left > 0;
        return (
          <OrderCard key={v.id} v={v} busy={busy(v.id)}
            sub={`${fmtEUR(v.priceEURMinor)} − commission €${(price * 0.05).toFixed(2)} → €${(price * 0.95).toFixed(2)} · ${v.buyerConfirmed ? "buyer ✓" : "auto"}`}>
            <Button size="sm" className="w-full" disabled={busy(v.id) || held}
              onClick={() => run(v.id, () => mpRelease(v.id), releaseLabel(v))}>
              {busy(v.id)
                ? "Settling…"
                : held
                  ? `Dispute window — ${mmss(left)} left`
                  : "Release & settle → seller"}
            </Button>
            {held && (
              <p className="text-sm text-muted-foreground">
                The buyer can still confirm or dispute. Settling the moment the seller says &ldquo;shipped&rdquo;
                would leave them no window at all — confirming ends it early.
              </p>
            )}
          </OrderCard>
        );
      })}

      <SectionLabel count={active.length}>All orders</SectionLabel>
      {active.length === 0 && <Empty>No activity yet.</Empty>}
      <div className="space-y-1.5">
        {active.map((v) => (
          <div key={v.id} data-order-row className="flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm">
            <span className="truncate">{v.product?.emoji} {v.product?.name ?? v.id.slice(0, 12)}</span>
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{fmtEUR(v.priceEURMinor)}</span>
            <StatusBadge status={v.status} label={v.statusLabel} busy={busy(v.id)} />
          </div>
        ))}
      </div>
    </Panel>
  );
}
