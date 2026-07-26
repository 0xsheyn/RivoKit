"use server";

import { getRivoKit } from "../lib/rivokit.server.ts";
import { productById } from "../lib/catalog.ts";

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
  /** Two-wallet mode: the seller's own wallet, where the floor EURC is forwarded. */
  sellerAddress: string | null;
  buyerConfirmed: boolean;
  disputeReason: string | null;
  createdAt: string;
  payments: Array<{ kind: string; status: string; txHash: string | null; chain: string | null }>;
  payout: { targetAmountMinor: string; disclaimer: string } | null;
};

export type MpResult = { ok: true; view: OrderView } | { ok: false; error: string };
export type MpListResult = { ok: true; views: OrderView[] } | { ok: false; error: string };

const RELEASE_PROOF = { kind: "manual" as const };

async function view(orderId: string): Promise<OrderView> {
  const { kit, store } = getRivoKit();
  const order = await kit.status(orderId);
  const events = await store.listEvents(orderId);
  const rawPayments = await store.listPayments(orderId);
  const p = kit.payoutFor(orderId);

  const meta = events.find((e) => e.type === "mp.order")?.payload as
    | { productId?: string; sellerAddress?: string } | undefined;
  const product = meta?.productId ? productById(meta.productId) ?? null : null;
  const shipped = events.find((e) => e.type === "mp.shipped")?.payload as { resi?: string } | undefined;
  const buyerConfirmed = events.some((e) => e.type === "mp.buyer_confirmed");
  const dispute = [...events].reverse().find((e) => e.type === "mp.dispute")?.payload as { reason?: string } | undefined;
  const disputeActive = Boolean(dispute) && !["released", "refunded", "refund_pending"].includes(order.state);

  const { status, statusLabel } = deriveStatus(order.state, {
    shipped: Boolean(shipped),
    buyerConfirmed,
    dispute: disputeActive,
  });

  return {
    id: order.id,
    payer: order.payer,
    product: product ? { id: product.id, name: product.name, seller: product.seller, emoji: product.emoji } : null,
    priceEURMinor: order.priceEUR,
    usdcAmount: order.usdcAmount,
    eurcOutMinor: p ? p.source.amountMinor.toString() : null,
    state: order.state,
    status,
    statusLabel,
    shippedResi: shipped?.resi ?? null,
    sellerAddress: meta?.sellerAddress ?? null,
    buyerConfirmed,
    disputeReason: disputeActive ? dispute?.reason ?? "no reason given" : null,
    createdAt: order.createdAt,
    payments: [
      ...rawPayments.map((pm) => ({ kind: pm.kind as string, status: pm.status, txHash: pm.tx_hash, chain: pm.chain })),
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
    payout: p ? { targetAmountMinor: p.target.amountMinor.toString(), disclaimer: p.disclaimer } : null,
  };
}

function deriveStatus(
  state: string,
  s: { shipped: boolean; buyerConfirmed: boolean; dispute: boolean },
): { status: string; statusLabel: string } {
  if (state === "refunded") return { status: "refunded", statusLabel: "Refunded" };
  if (state === "refund_pending") return { status: "refunding", statusLabel: "Refund in progress" };
  if (state === "released") return { status: "completed", statusLabel: "Done — seller paid" };
  if (state === "settlement_pending") return { status: "settling", statusLabel: "Settlement stalled (retryable)" };
  if (s.dispute) return { status: "dispute", statusLabel: "Disputed — awaiting the host" };
  if (state === "created") return { status: "waiting_payment", statusLabel: "Awaiting payment" };
  if (state === "funding_pending") return { status: "processing_payment", statusLabel: "Processing payment…" };
  // funded / shipped
  if (s.buyerConfirmed) return { status: "confirmed", statusLabel: "Buyer confirmed — awaiting host settlement" };
  if (s.shipped) return { status: "shipped", statusLabel: "In transit" };
  return { status: "paid", statusLabel: "Paid — awaiting shipment" };
}

const wrap = async (fn: () => Promise<string>): Promise<MpResult> => {
  try {
    return { ok: true, view: await view(await fn()) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
};

// ── Buyer ──────────────────────────────────────────────────────────────

/**
 * Checkout: create the order (locks FX quote, screens) + record the product.
 * `payer` defaults to the demo's server buyer; pass a connected wallet address to
 * make that address the payer — it will then sign the ERC-3009 authorization in
 * its own browser wallet (see mpAuthTypedData + mpPaySigned).
 */
export async function mpCheckout(
  productId: string,
  payer?: string,
  sellerAddress?: string,
): Promise<MpResult> {
  return wrap(async () => {
    const { kit, store, addresses } = getRivoKit();
    const product = productById(productId);
    if (!product) throw new Error(`no such product: ${productId}`);
    const order = await kit.createOrder({
      payer: (payer ?? addresses.buyer) as `0x${string}`,
      receiver: addresses.merchant as `0x${string}`,
      priceEURMinor: BigInt(product.priceEURMinor),
      receivingChain: "Arc_Testnet",
      wedge: "invoice", // auto_capture timeout — marketplace trusts delivery/confirm as proof
    });
    await store.recordEvent({
      orderId: order.id, type: "mp.order",
      payload: {
        productId: product.id, name: product.name, seller: product.seller,
        ...(sellerAddress ? { sellerAddress } : {}),
      },
    });
    return order.id;
  });
}

export type PaySource = "arc" | "unified" | "bridge";

export type Balances = {
  buyerArcUsdc: string; buyerSepUsdc: string; buyerGatewayUsdc: string; sellerEurc: string;
};

export async function mpBalances(): Promise<Balances | null> {
  try { return await getRivoKit().balances(); } catch { return null; }
}

/**
 * The demo's server-signed buyer address. The UI needs it to tell a demo order
 * (server holds the key → may pay via the funding rails) from an order whose
 * payer is a browser wallet (only that wallet can sign the ERC-3009).
 */
export async function mpDemoBuyer(): Promise<string | null> {
  try { return getRivoKit().addresses.buyer; } catch { return null; }
}

/** Arc USDC balance of a connected browser wallet (minor units, string). */
export async function mpAddrArcUsdc(address: string): Promise<string | null> {
  try { return await getRivoKit().addrArcUsdc(address); } catch { return null; }
}

export type RelayView = {
  /** Operator's Arc gas balance, in USDC (Arc gas IS USDC, 18 dp as gas). */
  gasUsdc: string | null;
  /** Below this, createOrder is refused rather than stalling mid-flight. */
  minGasUsdc: string;
  /** Operator fee in bps, grossed onto what the payer authorizes. */
  feeBps: number;
  feeReceiver: string;
};

/**
 * Health of the gasless relay: what the operator has left to pay gas with, and
 * the fee that refills it. Shown to the host — it is the host's cost.
 */
export async function mpRelay(): Promise<RelayView | null> {
  try {
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
  } catch { return null; }
}

/** EURC balance of a connected seller wallet (minor units, string). */
export async function mpAddrEurc(address: string): Promise<string | null> {
  try { return await getRivoKit().addrEurc(address); } catch { return null; }
}

/** Sepolia USDC balance of a connected browser wallet (minor units, string). */
export async function mpAddrSepUsdc(address: string): Promise<string | null> {
  try { return await getRivoKit().addrSepUsdc(address); } catch { return null; }
}

/** The USDC an order needs on Arc, in minor units — what a wallet rail must deliver. */
export async function mpOrderAmount(orderId: string): Promise<string | null> {
  try {
    const order = await getRivoKit().store.get(orderId);
    return order ? String(order.max_amount) : null;
  } catch { return null; }
}

/**
 * Mark an order as funding in flight. The connected wallet's cross-chain rails
 * run in the browser and take time (CCTP: minutes) — recording the intent first
 * means an interrupted transfer leaves a trail instead of a silent gap.
 */
export async function mpMarkFunding(orderId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { store } = getRivoKit();
    const order = await store.get(orderId);
    if (order?.state === "created") await store.transition(orderId, "funding_pending");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

/**
 * Record a wallet-signed funding leg (Gateway spend or CCTP mint) so it appears
 * in the order's transaction list next to the operator's escrow calls.
 * Idempotent on the nonce — a repeated call is a no-op, not a double entry.
 */
export async function mpRecordWalletFunding(
  orderId: string,
  kind: "gw-spend" | "bridge",
  txHash: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { store } = getRivoKit();
    const order = await store.get(orderId);
    if (!order) throw new Error("no such order");
    await store.recordPaymentIdempotent({
      orderId, nonce: `${orderId}:${kind}`, kind: "funding",
      status: "confirmed", txHash, chain: "Arc_Testnet", amountMinor: BigInt(order.max_amount),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

/** EIP-712 typed data — JSON-safe (bigints as strings) for a browser wallet to sign. */
export type AuthTypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
};

/**
 * Return the ERC-3009 authorization the connected wallet must sign for `orderId`.
 * The signature it produces is relayed by mpPaySigned — the buyer never pays gas.
 */
export async function mpAuthTypedData(orderId: string): Promise<{ ok: true; typedData: AuthTypedData } | { ok: false; error: string }> {
  try {
    const td = await getRivoKit().authTypedDataFor(orderId);
    return {
      ok: true,
      typedData: {
        domain: { ...td.domain, verifyingContract: td.domain.verifyingContract as string },
        types: td.types as AuthTypedData["types"],
        primaryType: td.primaryType,
        message: {
          from: td.message.from, to: td.message.to,
          value: td.message.value.toString(),
          validAfter: td.message.validAfter.toString(),
          validBefore: td.message.validBefore.toString(),
          nonce: td.message.nonce,
        },
      },
    };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

/**
 * Connected-wallet pay: the buyer signed the ERC-3009 authorization in their own
 * wallet; the operator relays it (gasless). The USDC must already be on Arc —
 * the wallet's cross-chain rails (Gateway spend, CCTP bridge) run in the browser
 * first and deliver it there (see wallet-rails.ts).
 */
export async function mpPaySigned(orderId: string, signature: string): Promise<MpResult> {
  return wrap(async () => {
    await getRivoKit().kit.fund(orderId, { signature: signature as `0x${string}` });
    return orderId;
  });
}

/**
 * Pay: bring USDC to Arc via the chosen rail, then authorize into escrow (gasless).
 *   arc     — buyer's USDC already on Arc → authorize directly.
 *   unified — spend from the Gateway unified balance to Arc, then authorize.
 *   bridge  — CCTP-bridge from Ethereum Sepolia to Arc, then authorize.
 * Each rail delivers usdcAmount onto Arc; the escrow authorize is identical.
 */
export async function mpPay(orderId: string, source: PaySource = "arc"): Promise<MpResult> {
  return wrap(async () => {
    const { kit, store, funding } = getRivoKit();
    const order = await store.get(orderId);
    if (!order) throw new Error("no such order");
    const amount = BigInt(order.max_amount);

    // Record the intent before moving cross-chain funds so the UI shows "memproses".
    if (source !== "arc" && order.state === "created") await store.transition(orderId, "funding_pending");

    if (source === "unified") {
      const spend = await funding.ub.spend({
        fromAdapter: funding.sepAdapter, fromChain: "Ethereum_Sepolia",
        toAdapter: funding.arcAdapter, toChain: "Arc_Testnet",
        recipientAddress: funding.buyer, amountMinor: amount,
      });
      await store.recordPaymentIdempotent({
        orderId, nonce: `${orderId}:gw-spend`, kind: "funding",
        status: "confirmed", txHash: spend.txHash, chain: "Arc_Testnet", amountMinor: amount,
      });
    } else if (source === "bridge") {
      const res = await funding.bridge.execute({
        fromAdapter: funding.sepAdapter, fromChain: funding.chains.sepolia,
        toAdapter: funding.arcAdapter, toChain: funding.chains.arc,
        amountMinor: amount, kitKey: funding.kitKey,
      });
      if (!res.mintTxHash) throw new Error("bridge produced no mint");
      await store.recordPaymentIdempotent({
        orderId, nonce: `${orderId}:bridge`, kind: "funding",
        status: "confirmed", txHash: res.mintTxHash, chain: "Arc_Testnet", amountMinor: amount,
      });
    }

    await kit.fund(orderId); // sign ERC-3009 + operator authorize (+ funded)
    return orderId;
  });
}

/** Buyer SIGNAL: goods received. Does not move funds — the host settles. */
export async function mpConfirm(orderId: string): Promise<MpResult> {
  return wrap(async () => {
    await getRivoKit().store.recordEvent({ orderId, type: "mp.buyer_confirmed", payload: {} });
    return orderId;
  });
}

/** Buyer SIGNAL: open a dispute. The host decides refund vs release. */
export async function mpDispute(orderId: string, reason: string): Promise<MpResult> {
  return wrap(async () => {
    await getRivoKit().store.recordEvent({ orderId, type: "mp.dispute", payload: { reason } });
    return orderId;
  });
}

// ── Seller ─────────────────────────────────────────────────────────────

/** Seller SIGNAL: shipped. Off-chain status only (funded → shipped). */
export async function mpShip(orderId: string, resi: string): Promise<MpResult> {
  return wrap(async () => {
    const { store } = getRivoKit();
    const o = await store.get(orderId);
    if (o && o.state === "funded") await store.transition(orderId, "shipped");
    await store.recordEvent({ orderId, type: "mp.shipped", payload: { resi } });
    return orderId;
  });
}

// ── Host / Marketplace (the authority) ─────────────────────────────────

/** Host settles: capture → swap ber-floor → payout MOCK. The seller gets EURC. */
export async function mpRelease(orderId: string): Promise<MpResult> {
  return wrap(async () => {
    const { kit, store, sendEurc } = getRivoKit();
    await kit.release(orderId, RELEASE_PROOF);

    // Two-wallet mode: the seller connected their own wallet, so forward the
    // guaranteed floor there. The settlement wallet has to be the capture
    // receiver — it is the one that runs the floored swap — so in this mode it
    // is a HOP, holding EURC for the seconds between swap and forward. Say that
    // plainly rather than implying the seller's wallet received it from escrow.
    const events = await store.listEvents(orderId);
    const meta = events.find((e) => e.type === "mp.order")?.payload as { sellerAddress?: string } | undefined;
    const alreadySent = events.some((e) => e.type === "mp.seller_payout");
    const order = await store.get(orderId);
    if (sendEurc && meta?.sellerAddress && order?.state === "released" && !alreadySent) {
      const floorMinor = BigInt(order.price_eur);
      const to = meta.sellerAddress as `0x${string}`;
      const sent = await sendEurc(to, floorMinor, "payout-seller");
      // Recorded as an event, not a payments row: `payment_kind` is a Postgres
      // enum without a "payout" member, and a demo-only leg does not justify
      // migrating the ledger schema. view() folds it into the tx list.
      await store.recordEvent({
        orderId, type: "mp.seller_payout",
        payload: { txHash: sent.txHash, to, amountMinor: floorMinor.toString() },
      });
    }
    return orderId;
  });
}

/** Host approves refund: void/refund back to the buyer. */
export async function mpRefund(orderId: string): Promise<MpResult> {
  return wrap(async () => { await getRivoKit().kit.refund(orderId); return orderId; });
}

// ── Reads ──────────────────────────────────────────────────────────────

export async function mpOrderView(orderId: string): Promise<MpResult> {
  return wrap(async () => orderId);
}

export async function mpListOrders(): Promise<MpListResult> {
  try {
    const { store } = getRivoKit();
    const orders = await store.listOrders(30);
    const views = await Promise.all(orders.map((o) => view(o.id)));
    return { ok: true, views };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}
