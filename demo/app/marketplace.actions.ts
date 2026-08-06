"use server";

import { getRivoKit } from "../lib/rivokit.server.ts";
import { productById } from "../lib/catalog.ts";
import { viewOne, type Balances, type OrderView, type PriceHint, type RelayView } from "../lib/board.server.ts";
import type { SourceChainId } from "../lib/source-chain.ts";
import { fundsMayBeInFlight } from "./wallet-errors.ts";
import { assertUnlocked } from "../lib/guard.server.ts";

// Re-exported so client components keep one import for "everything the
// marketplace speaks". The definition lives with the reads, in board.server.ts.
export type { Balances, OrderView, PriceHint, RelayView };

export type MpResult = { ok: true; view: OrderView } | { ok: false; error: string };
export type MpListResult = { ok: true; views: OrderView[] } | { ok: false; error: string };

const RELEASE_PROOF = { kind: "manual" as const };

const wrap = async (fn: () => Promise<string>): Promise<MpResult> => {
  try {
    return { ok: true, view: await viewOne(await fn()) };
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
  payoutTo: "wallet" | "bank" = "wallet",
): Promise<MpResult> {
  return wrap(async () => {
    // No amount cap here on purpose: the price comes from the fixed catalog,
    // not from the caller, so a listing is already its own ceiling.
    await assertUnlocked("Checking out");
    const { kit, store, addresses, payout } = getRivoKit();
    const product = productById(productId);
    if (!product) throw new Error(`no such product: ${productId}`);

    if (payoutTo === "bank" && !payout.enabled) {
      throw new Error(
        "Bank payout is not wired — CIRCLE_CPN_KEY and SELLER_PRIVATE_KEY are needed. Settle to a wallet instead.",
      );
    }

    // A bank order's captured USDC IS what the off-ramp spends, so it has to
    // land on the wallet that signs the Permit2 intent. Paying the merchant, as
    // wallet orders do, would leave the payout with nothing to pull from.
    const receiver = payoutTo === "bank" ? payout.receiver! : addresses.merchant;

    const order = await kit.createOrder({
      payer: (payer ?? addresses.buyer) as `0x${string}`,
      receiver: receiver as `0x${string}`,
      priceEURMinor: BigInt(product.priceEURMinor),
      receivingChain: "Arc_Testnet",
      wedge: "invoice", // auto_capture timeout — marketplace trusts delivery/confirm as proof
      payoutTo,
      // A bank order's buffer has to absorb CPN's spread AND its four fees
      // between checkout and release, not a swap's slippage. The default 150
      // bps is sized for the latter and leaves a bank order stalling in
      // `settlement_pending` on an ordinary rate move.
      ...(payoutTo === "bank" ? { bufferBps: 400 } : {}),
    });
    await store.recordEvent({
      orderId: order.id, type: "mp.order",
      payload: {
        productId: product.id, name: product.name, seller: product.seller,
        payoutTo, ...(payoutTo === "bank" ? { corridor: payout.corridor } : {}),
        ...(sellerAddress ? { sellerAddress } : {}),
      },
    });
    return order.id;
  });
}

/**
 * Indicative USDC price per listing, per destination.
 *
 * INDICATIVE, and the UI must say so: the binding number is computed at
 * `createOrder`, against a quote that lives 30–60 seconds. Two figures rather
 * than one because the two destinations are sized against different markets —
 * a wallet order inverts the settlement swap, a bank order asks the payout rail
 * — so the same listing genuinely costs different amounts of USDC depending on
 * where the money is going.
 */
export type PaySource = "arc" | "unified" | "bridge";

/** The USDC an order needs on Arc, in minor units — what a wallet rail must deliver. */
export async function mpOrderAmount(orderId: string): Promise<string | null> {
  try {
    const order = await getRivoKit().store.get(orderId);
    return order ? String(order.max_amount) : null;
  } catch { return null; }
}

/**
 * Close an order whose ERC-3009 authorization window has passed.
 *
 * The guard is server-side and non-negotiable: only an order still in `created`
 * or `funding_pending` AND already past `preApprovalExpiry` can be closed. Both
 * halves matter — the first because a funded order's money is on-chain and not
 * this action's business, the second because a healthy order must never be
 * failable from a button.
 *
 * Nothing is refunded here because nothing was ever collected: the escrow
 * rejected the collection, so a cross-chain rail that already minted left the
 * USDC in the PAYER's own address on Arc, where it still is.
 */
export async function mpExpireOrder(orderId: string): Promise<MpResult> {
  return wrap(async () => {
    const { store } = getRivoKit();
    const order = await store.get(orderId);
    if (!order) throw new Error("no such order");
    if (order.state !== "created" && order.state !== "funding_pending") {
      throw new Error(`order is ${order.state} — only an unfunded order can be closed`);
    }
    if (Date.parse(order.pre_approval_expiry) > Date.now()) {
      throw new Error("the authorization window is still open — pay it instead");
    }
    await store.transition(orderId, "failed", { failureReason: "pre-approval expired before funding" });
    return orderId;
  });
}

/**
 * Mark an order as funding in flight — MONEY HAS MOVED, or may have.
 *
 * Call this once the burn is known to have happened, never before the attempt.
 * `funding_pending` has no way back in the state machine, so an order marked
 * ahead of a failure that moved nothing is frozen with its pay control gone.
 * The browser rails decide with `fundsMayBeInFlight`.
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
 *   bridge  — CCTP-bridge from `from` to Arc, then authorize.
 * Each rail delivers usdcAmount onto Arc; the escrow authorize is identical.
 *
 * `from` names the source chain for the two cross-chain rails and is ignored by
 * `arc`. An unknown value falls back to the default chain rather than failing —
 * see `demo/lib/source-chain.ts`.
 */
export async function mpPay(
  orderId: string,
  source: PaySource = "arc",
  from?: SourceChainId,
): Promise<MpResult> {
  return wrap(async () => {
    await assertUnlocked("Paying for an order");
    const { kit, store, funding } = getRivoKit();
    const order = await store.get(orderId);
    if (!order) throw new Error("no such order");
    const amount = BigInt(order.max_amount);
    const src = funding.source(from);

    /**
     * `funding_pending` means MONEY IS MOVING, and the state machine offers it
     * no way back (`funding_pending: ["funded", "failed"]`) precisely because a
     * CCTP burn that landed must never be re-sent.
     *
     * So it is written when that is true, and not a moment earlier. Marking the
     * intent up front — which is what this used to do — turned every clean
     * failure (a dead RPC, a short balance, a declined prompt) into an order
     * frozen at "Processing payment…" with its pay control gone, even though
     * nothing had left the buyer's wallet.
     */
    const markInFlight = async () => {
      const now = await store.get(orderId);
      if (now?.state === "created") await store.transition(orderId, "funding_pending");
    };
    const runRail = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        if (fundsMayBeInFlight(e)) await markInFlight();
        throw e;
      }
    };

    if (source === "unified") {
      await runRail(async () => {
        const spend = await funding.ub.spend({
          fromAdapter: src.adapter, fromChain: src.chain,
          toAdapter: funding.arcAdapter, toChain: "Arc_Testnet",
          recipientAddress: funding.buyer, amountMinor: amount,
        });
        await markInFlight();
        await store.recordPaymentIdempotent({
          orderId, nonce: `${orderId}:gw-spend`, kind: "funding",
          status: "confirmed", txHash: spend.txHash, chain: "Arc_Testnet", amountMinor: amount,
        });
      });
    } else if (source === "bridge") {
      await runRail(async () => {
        const res = await funding.bridge.execute({
          fromAdapter: src.adapter, fromChain: src.chain,
          toAdapter: funding.arcAdapter, toChain: funding.chains.arc,
          amountMinor: amount, kitKey: funding.kitKey,
        });
        if (!res.mintTxHash) throw new Error("bridge produced no mint");
        await markInFlight();
        await store.recordPaymentIdempotent({
          orderId, nonce: `${orderId}:bridge`, kind: "funding",
          status: "confirmed", txHash: res.mintTxHash, chain: "Arc_Testnet", amountMinor: amount,
        });
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

/**
 * Host settles. What that means depends on the order:
 *
 *   payoutTo "wallet" — capture → floored swap → the seller holds EURC on Arc.
 *   payoutTo "bank"   — capture → CPN broadcast → the order sits in
 *                       `payout_pending` until the fiat leg lands. IRREVERSIBLE
 *                       past broadcast, and not finished when this returns.
 */
export async function mpRelease(orderId: string): Promise<MpResult> {
  return wrap(async () => {
    // Captures the escrow, and on a bank order carries straight through to an
    // irreversible CPN broadcast.
    await assertUnlocked("Releasing an order");
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

/**
 * Ask the off-ramp where a broadcast payout has got to, and advance the order
 * if the fiat has landed.
 *
 * The demo has no public webhook endpoint, so nothing else moves a bank order
 * off `payout_pending`. This is the fallback the SDK documents, not a second
 * source of truth: it writes only what the rail reports.
 */
export async function mpRefreshPayout(orderId: string): Promise<MpResult> {
  return wrap(async () => {
    const { kit } = getRivoKit();
    await kit.refreshPayout(orderId);
    return orderId;
  });
}

/** Host approves refund: void/refund back to the buyer. */
export async function mpRefund(orderId: string): Promise<MpResult> {
  return wrap(async () => {
    // Post-capture, this pulls from the OPERATOR's own balance — 154x the cost
    // of a pre-capture void, and paid by the host either way.
    await assertUnlocked("Refunding an order");
    await getRivoKit().kit.refund(orderId);
    return orderId;
  });
}

// ── Reads ──────────────────────────────────────────────────────────────
