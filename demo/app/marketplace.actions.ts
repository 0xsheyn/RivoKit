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
    | { productId?: string } | undefined;
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
    buyerConfirmed,
    disputeReason: disputeActive ? dispute?.reason ?? "tanpa alasan" : null,
    createdAt: order.createdAt,
    payments: rawPayments.map((pm) => ({ kind: pm.kind, status: pm.status, txHash: pm.tx_hash, chain: pm.chain })),
    payout: p ? { targetAmountMinor: p.target.amountMinor.toString(), disclaimer: p.disclaimer } : null,
  };
}

function deriveStatus(
  state: string,
  s: { shipped: boolean; buyerConfirmed: boolean; dispute: boolean },
): { status: string; statusLabel: string } {
  if (state === "refunded") return { status: "refunded", statusLabel: "Refund selesai" };
  if (state === "refund_pending") return { status: "refunding", statusLabel: "Refund diproses" };
  if (state === "released") return { status: "completed", statusLabel: "Selesai — seller dibayar" };
  if (state === "settlement_pending") return { status: "settling", statusLabel: "Settlement tertahan (retry)" };
  if (s.dispute) return { status: "dispute", statusLabel: "Sengketa — menunggu keputusan host" };
  if (state === "created") return { status: "waiting_payment", statusLabel: "Menunggu pembayaran" };
  if (state === "funding_pending") return { status: "processing_payment", statusLabel: "Memproses pembayaran…" };
  // funded / shipped
  if (s.buyerConfirmed) return { status: "confirmed", statusLabel: "Diterima pembeli — menunggu settlement host" };
  if (s.shipped) return { status: "shipped", statusLabel: "Dalam pengiriman" };
  return { status: "paid", statusLabel: "Dibayar — menunggu seller mengirim" };
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
export async function mpCheckout(productId: string, payer?: string): Promise<MpResult> {
  return wrap(async () => {
    const { kit, store, addresses } = getRivoKit();
    const product = productById(productId);
    if (!product) throw new Error(`produk ${productId} tak ada`);
    const order = await kit.createOrder({
      payer: (payer ?? addresses.buyer) as `0x${string}`,
      receiver: addresses.merchant as `0x${string}`,
      priceEURMinor: BigInt(product.priceEURMinor),
      receivingChain: "Arc_Testnet",
      wedge: "invoice", // auto_capture timeout — marketplace trusts delivery/confirm as proof
    });
    await store.recordEvent({
      orderId: order.id, type: "mp.order",
      payload: { productId: product.id, name: product.name, seller: product.seller },
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

/** Arc USDC balance of a connected browser wallet (minor units, string). */
export async function mpAddrArcUsdc(address: string): Promise<string | null> {
  try { return await getRivoKit().addrArcUsdc(address); } catch { return null; }
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
 * wallet; the operator relays it (gasless). Arc rail only — the wallet's USDC is
 * already on Arc; cross-chain rails need the host's own key and stay server-signed.
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
    if (!order) throw new Error("order tak ada");
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
      if (!res.mintTxHash) throw new Error("bridge tak menghasilkan mint");
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
  return wrap(async () => { await getRivoKit().kit.release(orderId, RELEASE_PROOF); return orderId; });
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
