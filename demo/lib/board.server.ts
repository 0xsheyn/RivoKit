/**
 * The demo's READ side: order views, and the snapshots a page or a poll needs.
 *
 * WHY THIS IS NOT IN `marketplace.actions.ts`
 *
 * Reads and writes had ended up in the same file, and the file was marked
 * `"use server"` — so every read was a Server Action. That is the wrong
 * transport for a poll. Server Actions are POSTs the App Router puts through
 * one queue together with navigations: a four-second board poll and eight
 * mount-time reads on the withdraw page do not run side by side, they run
 * one after another, and a click or a route change waits behind whatever is
 * in flight. Reads live here so a Route Handler (parallel, cacheable, plain
 * GET) and a Server Component can both use them, and Server Actions can go
 * back to being what they are for: mutations.
 *
 * Server-only. `demo/lib/rivokit.server.ts` reads private keys and the Circle
 * key — never import this from a client component.
 */
import { getRivoKit } from "./rivokit.server.ts";
import { CATALOG, canPayoutToBank, productById } from "./catalog.ts";
import { corridorList, listCashouts, payoutRailFor, sellerInfo, type CorridorInfo } from "./cpn.server.ts";
import { toDestinationMinor } from "../../src/payout/rail.ts";
import type { SourceChainId } from "./source-chain.ts";
import { mintBalance, mintDepositInfo, mintPayouts } from "./mint.server.ts";
import { orderFromRecord, type Order } from "../../src/sdk/rivokit.ts";
import type { OrderRecord } from "../../src/orchestrator/order-store.ts";
import type { PayoutInstruction } from "../../src/payout/instruction.ts";

// Marketplace status derived from the on-chain OrderState PLUS off-chain signals
// (shipping, buyer confirmation, dispute) recorded in the events table. The chain
// stays the source of truth for MONEY; these signals only drive the host's
// decision of WHEN to release or refund — never the funds themselves.
export type OrderView = {
  id: string;
  payer: string;
  product: { id: string; name: string; seller: string; emoji: string } | null;
  priceEURMinor: string;
  usdcAmount: string | null;
  eurcOutMinor: string | null;
  state: string;
  status: string;
  statusLabel: string;
  shippedResi: string | null;
  /** When the seller marked it shipped — the dispute window counts from here. */
  shippedAt: string | null;
  /** Two-wallet mode: the seller's own wallet, where the floor EURC is forwarded. */
  sellerAddress: string | null;
  buyerConfirmed: boolean;
  disputeReason: string | null;
  createdAt: string;
  /**
   * The ERC-3009 `validBefore` the payer signs against — one hour from checkout
   * (`expiriesFor`). Past it the escrow REFUSES to collect, so an unfunded order
   * is finished whether or not anything says so. The UI needs it to stop
   * offering a payment the chain will reject.
   */
  preApprovalExpiry: string;
  payments: Array<{ kind: string; status: string; txHash: string | null; chain: string | null }>;
  /** Where this order's money is bound, and who holds the captured USDC. */
  payoutTo: "wallet" | "bank";
  receiver: string;
  /**
   * `label` is the field a UI must not soften: MOCK means nothing moved, LIVE
   * means a real payment network has the money and `reference.status` is the
   * only word on whether it arrived.
   */
  payout: {
    kind: string;
    label: "MOCK" | "LIVE";
    executed: boolean;
    targetAmountMinor: string;
    targetCurrency: string;
    targetScale: number;
    sourceCurrency: string;
    reference: { rail: string; corridor: string; paymentId: string; status: string; txHash?: string | undefined } | null;
    disclaimer: string;
  } | null;
};

type EventRow = { type: string; payload: unknown; received_at: string };
type PaymentRow = { kind: string; status: string; tx_hash: string | null; chain: string | null };

/**
 * Assemble one view from parts already read.
 *
 * Takes its inputs instead of fetching them: the single-order path reads them
 * for one id, the board reads them for thirty in three queries, and both end up
 * here so there is one definition of what an order looks like on screen.
 */
function buildView(
  record: OrderRecord,
  events: EventRow[],
  rawPayments: PaymentRow[],
  p: PayoutInstruction | null,
): OrderView {
  const order: Order = orderFromRecord(record);

  const meta = events.find((e) => e.type === "mp.order")?.payload as
    | { productId?: string; sellerAddress?: string } | undefined;
  const product = meta?.productId ? productById(meta.productId) ?? null : null;
  const shippedEvent = events.find((e) => e.type === "mp.shipped");
  const shipped = shippedEvent?.payload as { resi?: string } | undefined;
  const buyerConfirmed = events.some((e) => e.type === "mp.buyer_confirmed");
  const dispute = [...events].reverse().find((e) => e.type === "mp.dispute")?.payload as { reason?: string } | undefined;
  const disputeActive = Boolean(dispute) && !["released", "paid_out", "payout_pending", "refunded", "refund_pending"].includes(order.state);

  const { status, statusLabel } = deriveStatus(order.state, {
    shipped: Boolean(shipped),
    buyerConfirmed,
    dispute: disputeActive,
    preApprovalPassed: Date.parse(record.pre_approval_expiry) <= Date.now(),
  });

  return {
    id: order.id,
    payer: order.payer,
    // Where this order's money is bound, and who therefore holds the captured
    // USDC. A bank order pays the seller's wallet, not the merchant's — the
    // off-ramp spends from wherever capture landed.
    payoutTo: order.payoutTo,
    receiver: order.receiver,
    product: product ? { id: product.id, name: product.name, seller: product.seller, emoji: product.emoji } : null,
    priceEURMinor: order.priceEUR,
    usdcAmount: order.usdcAmount,
    // Only meaningful on the wallet path: a bank order runs no swap, so its
    // payout source is USDC, not EURC. Reporting that as "eurcOut" would be a
    // quiet lie about which asset the seller holds.
    eurcOutMinor: p && p.source.currency === "EURC" ? p.source.amountMinor.toString() : null,
    state: order.state,
    status,
    statusLabel,
    shippedResi: shipped?.resi ?? null,
    shippedAt: shippedEvent?.received_at ?? null,
    sellerAddress: meta?.sellerAddress ?? null,
    buyerConfirmed,
    disputeReason: disputeActive ? dispute?.reason ?? "no reason given" : null,
    createdAt: order.createdAt,
    preApprovalExpiry: record.pre_approval_expiry,
    payments: [
      ...rawPayments.map((pm) => ({ kind: pm.kind, status: pm.status, txHash: pm.tx_hash, chain: pm.chain })),
      // The two-wallet forward lives in events (see mpRelease) but belongs in
      // the same list — it is the leg that actually put EURC in the seller's wallet.
      ...events
        .filter((e) => e.type === "mp.seller_payout")
        .map((e) => ({
          kind: "payout", status: "confirmed",
          txHash: (e.payload as { txHash?: string })?.txHash ?? null,
          chain: "Arc_Testnet",
        })),
    ],
    // The payout record as it stands. `label` is the part a UI must not soften:
    // MOCK means nothing moved, LIVE means a real payment network has the money
    // and `reference.status` is the only word on whether it arrived.
    payout: p
      ? {
          kind: p.kind,
          label: p.label,
          executed: p.executed,
          targetAmountMinor: p.target.amountMinor.toString(),
          targetCurrency: p.target.currency,
          targetScale: p.target.scale,
          sourceCurrency: p.source.currency,
          reference: p.reference,
          disclaimer: p.disclaimer,
        }
      : null,
  };
}

export function deriveStatus(
  state: string,
  s: { shipped: boolean; buyerConfirmed: boolean; dispute: boolean; preApprovalPassed: boolean },
): { status: string; statusLabel: string } {
  if (state === "failed") return { status: "failed", statusLabel: "Failed" };
  if (state === "refunded") return { status: "refunded", statusLabel: "Refunded" };
  if (state === "refund_pending") return { status: "refunding", statusLabel: "Refund in progress" };
  if (state === "released") return { status: "completed", statusLabel: "Done — seller paid" };
  // Broadcast is not delivery. `payout_pending` means the seller's USDC has left
  // for a payment network that reports minutes later, so calling it "done" here
  // would be the one claim this state exists to avoid.
  if (state === "paid_out") return { status: "completed", statusLabel: "Done — paid to the seller's bank" };
  if (state === "payout_pending") return { status: "paying_out", statusLabel: "Bank payout in transit" };
  if (state === "settlement_pending") return { status: "settling", statusLabel: "Settlement stalled (retryable)" };
  if (s.dispute) return { status: "dispute", statusLabel: "Disputed — awaiting the host" };
  // Before anything else about an unfunded order: past `preApprovalExpiry` the
  // escrow refuses to collect, so "awaiting payment" would be an invitation to a
  // transaction the chain has already decided to reject. Only `created` and
  // `funding_pending` can be here — every later state has the money.
  if (s.preApprovalPassed && (state === "created" || state === "funding_pending")) {
    return { status: "expired", statusLabel: "Expired — authorization window closed" };
  }
  if (state === "created") return { status: "waiting_payment", statusLabel: "Awaiting payment" };
  if (state === "funding_pending") return { status: "processing_payment", statusLabel: "Processing payment…" };
  // funded / shipped
  if (s.buyerConfirmed) return { status: "confirmed", statusLabel: "Buyer confirmed — awaiting host settlement" };
  if (s.shipped) return { status: "shipped", statusLabel: "In transit" };
  return { status: "paid", statusLabel: "Paid — awaiting shipment" };
}

/** One order, read fresh. The shape every mutation returns. */
export async function viewOne(orderId: string): Promise<OrderView> {
  const { store } = getRivoKit();
  const [record, events, payments, payout] = await Promise.all([
    store.get(orderId),
    store.listEvents(orderId),
    store.listPayments(orderId),
    store.getPayout(orderId),
  ]);
  if (!record) throw new Error(`no such order: ${orderId}`);
  return buildView(record, events, payments as PaymentRow[], payout);
}

/**
 * The whole board, in four queries rather than five per order.
 *
 * This was `listOrders` followed by a `view()` per order, and `view()` itself
 * made five sequential round trips — thirty orders on a four-second poll came
 * to a hundred and fifty queries a tick. Nothing about the data required that;
 * it was the shape.
 */
export async function listViews(limit = 30): Promise<OrderView[]> {
  const { store } = getRivoKit();
  const orders = await store.listOrders(limit);
  const ids = orders.map((o) => o.id);

  const [events, payments, payouts] = await Promise.all([
    store.listEventsFor(ids),
    store.listPaymentsFor(ids),
    store.listPayoutsFor(ids),
  ]);

  return orders.map((o) =>
    buildView(o, events[o.id] ?? [], (payments[o.id] ?? []) as PaymentRow[], payouts[o.id] ?? null),
  );
}

// ── Balances, with a short shared TTL ──────────────────────────────────

export type Balances = {
  buyerArcUsdc: string;
  /** USDC per source chain, keyed by `SourceChainId` — the bridge rail's stock. */
  buyerSrcUsdc: Record<SourceChainId, string>;
  buyerGatewayUsdc: string;
  sellerEurc: string;
};

/**
 * Balances are six chain reads and a Gateway call. Several readers want them at
 * once — the board poll, the page render, the withdraw screen — and Arc's public
 * RPC rejects around the third concurrent call, so asking three times is not
 * merely wasteful, it is how you get an unreadable balance.
 *
 * A few seconds of staleness costs nothing here: every number on screen is a
 * chain balance that a poll re-reads anyway.
 */
const BALANCES_TTL_MS = 5_000;
let balancesCache: { at: number; value: Promise<Balances> } | null = null;

export function cachedBalances(): Promise<Balances> {
  const now = Date.now();
  if (balancesCache && now - balancesCache.at < BALANCES_TTL_MS) return balancesCache.value;

  const value = getRivoKit()
    .balances()
    .catch((e) => {
      // Do not cache a failure: the next reader should get a real attempt, not
      // five seconds of the same error.
      balancesCache = null;
      throw e;
    }) as Promise<Balances>;
  balancesCache = { at: now, value };
  return value;
}

// ── Snapshots ──────────────────────────────────────────────────────────

export type RelayView = {
  gasUsdc: string | null;
  minGasUsdc: string;
  feeBps: number;
  feeReceiver: string;
};

export type PriceHint = { productId: string; walletUsdc: string | null; bankUsdc: string | null };

export type BoardSnapshot = {
  views: OrderView[];
  balances: Balances | null;
  relay: RelayView | null;
  /** Approximate USDC per listing — the storefront's "you pay ≈" line. */
  hints: PriceHint[];
  /** Whether a bank payout can be offered at all, and through which corridor. */
  payout: { enabled: boolean; corridor: string };
};

/**
 * Everything the market page shows, in ONE round trip.
 *
 * It used to be four separate reads the browser made itself — orders, balances,
 * relay, and a payout refresh per pending order — each a Server Action, each
 * waiting for the last. They are independent, so here they are simply awaited
 * together.
 *
 * Every part degrades on its own. A page that renders nothing because the
 * Gateway is unreachable is worse than a page that renders with one number
 * missing, and the RPC being rate-limited is the normal weather here.
 */
export async function boardSnapshot(): Promise<BoardSnapshot> {
  const { payout } = getRivoKit();
  const [views, balances, relay, hints] = await Promise.all([
    listViews().catch(() => [] as OrderView[]),
    cachedBalances().catch(() => null),
    relaySnapshot().catch(() => null),
    priceHints().catch(() => [] as PriceHint[]),
  ]);
  return {
    views,
    balances,
    relay,
    hints,
    payout: { enabled: payout.enabled, corridor: payout.corridor },
  };
}

const WALLET_BUFFER_BPS = 150n; // SDK default, sized for swap slippage
const BANK_BUFFER_BPS = 400n; // what a bank order passes: CPN spread + four fees
const HINT_TTL_MS = 60_000;

let hintCache: { at: number; hints: PriceHint[] } | null = null;

let hintRefresh: Promise<PriceHint[]> | null = null;

/**
 * Approximate USDC per listing — served stale, refreshed behind the caller.
 *
 * Approximate BY DESIGN: the binding number is quoted at checkout. That is what
 * licenses this to hand back a minute-old figure rather than make the page wait
 * for it. Getting it fresh means one StableFX estimate plus a CPN limits+quote
 * pair per bank-eligible listing, and on a cold instance that was the single
 * slowest thing between a request for the market page and its first paint —
 * spent on a number the UI itself labels with a "≈".
 *
 * So: a stale answer goes out immediately and the refresh runs on its own. Only
 * the very first caller, with nothing cached at all, waits.
 */
export async function priceHints(): Promise<PriceHint[]> {
  const fresh = hintCache && Date.now() - hintCache.at < HINT_TTL_MS;
  if (fresh && hintCache) return hintCache.hints;

  // Stale but present: answer now, refresh once (not once per caller).
  if (hintCache) {
    hintRefresh ??= computeHints()
      .catch(() => hintCache!.hints)
      .finally(() => { hintRefresh = null; });
    return hintCache.hints;
  }
  return computeHints();
}

async function computeHints(): Promise<PriceHint[]> {
  const { kit, addresses, payout } = getRivoKit();
  const hints: PriceHint[] = CATALOG.map((p) => ({ productId: p.id, walletUsdc: null, bankUsdc: null }));

  // ONE quote for the whole catalog, scaled per listing. Six live quotes on
  // every page load would spend the Arc RPC's budget on a figure that is
  // approximate by definition.
  try {
    const probeIn = 10_000_000n;
    const q = await kit.estimateSwap({ address: addresses.buyer, amountInMinor: probeIn });
    const out = BigInt(q.amountOutMinor);
    if (out > 0n) {
      for (const h of hints) {
        const price = BigInt(productById(h.productId)!.priceEURMinor);
        const net = (price * BigInt(q.amountInMinor)) / out;
        h.walletUsdc = (net + (net * WALLET_BUFFER_BPS) / 10_000n).toString();
      }
    }
  } catch {
    /* leave null — the UI shows the guaranteed euro price and no estimate */
  }

  // The bank figure comes from the rail itself, and only for listings that
  // clear the corridor minimum — everything else is refused at createOrder.
  if (payout.enabled) {
    const eligible = CATALOG.filter(canPayoutToBank);
    for (const p of eligible) {
      try {
        const rail = payoutRailFor(payout.corridor);
        if (!rail.estimate) break;
        // The rail prices in the DESTINATION's scale — fiat cents, not the
        // 6-decimal minor units money is carried in everywhere else. Handing it
        // the 6-decimal figure asks for a payout 10 000× too large, and the
        // quote comes back looking plausible: 119 982 USDC for a €10 listing.
        const limits = await rail.limits();
        const destinationMinor = toDestinationMinor(BigInt(p.priceEURMinor), limits.destinationScale);
        const { requiredSourceMinor } = await rail.estimate(destinationMinor);
        const hint = hints.find((h) => h.productId === p.id);
        if (hint) {
          hint.bankUsdc = (requiredSourceMinor + (requiredSourceMinor * BANK_BUFFER_BPS) / 10_000n).toString();
        }
      } catch {
        /* corridor unreachable or below its minimum — no bank figure to show */
      }
    }
  }

  hintCache = { at: Date.now(), hints };
  return hints;
}

async function relaySnapshot(): Promise<RelayView> {
  const { relay } = getRivoKit();
  let gasUsdc: string | null = null;
  try {
    gasUsdc = (Number(await relay.operatorGas() / 10n ** 12n) / 1e6).toFixed(4);
  } catch { /* RPC quota — report unknown rather than a wrong zero */ }
  return {
    gasUsdc,
    minGasUsdc: (Number(relay.minGasWei / 10n ** 12n) / 1e6).toFixed(2),
    feeBps: relay.feeBps,
    feeReceiver: relay.feeReceiver,
  };
}

export type CashoutRow = {
  paymentId: string;
  corridor: string;
  status: string;
  source: string;
  sourceCurrency: string;
  destination: string;
  destinationCurrency: string;
  signedBy: "server" | "wallet";
  orderId: string | null;
  failureReason: string | null;
  createdAt: string;
};

const dec = (minor: string, scale: number) => (Number(minor) / 10 ** scale).toFixed(scale === 6 ? 2 : scale);

export async function cashoutRows(limit = 8): Promise<CashoutRow[]> {
  const rows = await listCashouts(limit);
  return rows.map((r) => ({
    paymentId: r.payment_id,
    corridor: r.corridor,
    status: r.status,
    source: dec(r.source_minor, 6),
    sourceCurrency: r.source_currency,
    destination: dec(r.destination_minor, r.destination_scale),
    destinationCurrency: r.destination_currency,
    signedBy: r.signed_by,
    orderId: r.order_id,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
  }));
}

export type MintSnapshot = {
  balances: Array<{ amount: string; currency: string }>;
  deposit: Awaited<ReturnType<typeof mintDepositInfo>>;
  payouts: Awaited<ReturnType<typeof mintPayouts>>;
};

export type WithdrawSnapshot = {
  balances: Balances | null;
  seller: { address: string; usdcMinor: string } | null;
  corridors: CorridorInfo[];
  cashouts: CashoutRow[] | null;
  mint: MintSnapshot | null;
};

/**
 * Everything the withdraw page shows, in ONE round trip.
 *
 * Eight components used to each fetch their own slice on mount, through the
 * Server Action queue, one after another — two of them (`MintRedeem` and
 * `SendEurcToMint`) fetching the very same thing. Whatever the slowest call
 * was, every later one waited for it.
 *
 * `null` for a section that failed rather than a rejected promise: Circle Mint
 * being unreachable must not blank the CPN panels beside it.
 */
export async function withdrawSnapshot(): Promise<WithdrawSnapshot> {
  const [balances, seller, cashouts, mint] = await Promise.all([
    cachedBalances().catch(() => null),
    sellerInfo().catch(() => null),
    cashoutRows().catch(() => null),
    mintSnapshot().catch(() => null),
  ]);
  return { balances, seller, corridors: corridorList(), cashouts, mint };
}

export async function mintSnapshot(): Promise<MintSnapshot> {
  const [balances, deposit, payouts] = await Promise.all([mintBalance(), mintDepositInfo(), mintPayouts(8)]);
  return { balances, deposit, payouts };
}

// ── A connected wallet's own balances ──────────────────────────────────

export type WalletSnapshot = {
  /** USDC on Arc, minor units. `null` means the read failed, not zero. */
  arcUsdc: string | null;
  /** EURC on Arc, minor units, or the reason it could not be read. */
  eurc: string | null;
  eurcError: string | null;
  /** USDC per source chain — only read when asked for; four more RPC calls. */
  srcUsdc: Record<SourceChainId, string> | null;
};

/**
 * What a connected browser wallet holds. One call for what was three.
 *
 * `fields` is honoured rather than reading everything: the source-chain sweep
 * touches four more RPCs and only the funding rail selector needs it, while the
 * header wants a single number every few seconds.
 *
 * `eurcError` is carried separately because a failed EURC read used to come
 * back as `null`, which is indistinguishable from an empty wallet — and Arc's
 * public RPC refuses around the third concurrent call often enough that the
 * difference matters.
 */
export async function walletSnapshot(
  address: string,
  fields: { arc?: boolean; eurc?: boolean; src?: boolean } = { arc: true },
): Promise<WalletSnapshot> {
  const kit = getRivoKit();
  const [arcUsdc, eurc, srcUsdc] = await Promise.all([
    fields.arc ? kit.addrArcUsdc(address).catch(() => null) : Promise.resolve(null),
    fields.eurc
      ? kit.addrEurc(address).then((v) => ({ v, e: null })).catch((e: unknown) => ({ v: null, e: String((e as Error)?.message ?? e) }))
      : Promise.resolve({ v: null, e: null }),
    fields.src ? kit.addrSrcUsdc(address).catch(() => null) : Promise.resolve(null),
  ]);
  return { arcUsdc, eurc: eurc.v, eurcError: eurc.e, srcUsdc };
}
