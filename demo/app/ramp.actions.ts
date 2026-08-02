"use server";

import type { Hex } from "viem";
import {
  broadcastPayment,
  broadcastSignedPayment,
  corridorList,
  getCpnRamp,
  listCashouts,
  preparedIntent,
  preparePayment,
  sellerInfo,
  type CorridorInfo,
} from "../lib/cpn.server.ts";

/** The payout corridors the seller can cash out to (EUR/BRL/MXN/USD). */
export async function cpnCorridorsAction(): Promise<CorridorInfo[]> {
  return corridorList();
}

/** One past cash-out, decimalised for display. */
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

export type CashoutHistoryResult = { ok: true; rows: CashoutRow[] } | { ok: false; error: string };

const dec = (minor: string, scale: number) => (Number(minor) / 10 ** scale).toFixed(scale === 6 ? 2 : scale);

/** Past CPN cash-outs, newest first — the panel's history. */
export async function cpnHistoryAction(limit = 8): Promise<CashoutHistoryResult> {
  try {
    const rows = await listCashouts(limit);
    return {
      ok: true,
      rows: rows.map((r) => ({
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
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A quote flattened for the UI — money as strings, like the rest of the demo. */
export type CpnQuoteView = {
  quoteId: string;
  expiresAt: string;
  source: { amount: string; currency: string };
  destination: { amount: string; currency: string };
  /** Applied USDC→EUR rate. */
  rate: string;
  /** FX margin (raw vs applied) in basis points. */
  spreadBps: number;
  fees: { total: string; currency: string; byType: Record<string, string> };
};

export type CpnQuoteResult = { ok: true; quote: CpnQuoteView } | { ok: false; error: string };

/**
 * Live CPN quote for USDC(Arc) → EUR/SEPA. Read-only and safe — no payment is
 * created, nothing broadcasts. Drives the demo's off-ramp panel.
 */
export async function cpnQuoteAction(sourceAmountUsdc: string): Promise<CpnQuoteResult> {
  try {
    const ramp = getCpnRamp();
    const { quote, fees, spreadBps } = await ramp.quote({ sourceAmount: sourceAmountUsdc });
    return {
      ok: true,
      quote: {
        quoteId: quote.id,
        expiresAt: quote.quoteExpireDate,
        source: quote.sourceAmount,
        destination: quote.destinationAmount,
        rate: quote.exchangeRate.rate,
        spreadBps: Math.round(spreadBps),
        fees: { total: fees.total.amount, currency: fees.total.currency, byType: fees.byType },
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type SellerInfoView = { address: string; usdcMinor: string };
export type SellerInfoResult = { ok: true; seller: SellerInfoView } | { ok: false; error: string };

/** The seller wallet's accumulated USDC on Arc — what's available to cash out. */
export async function cpnSellerBalanceAction(): Promise<SellerInfoResult> {
  try {
    return { ok: true, seller: await sellerInfo() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Full payment flow (prepare → broadcast) ────────────────────────────

export type PreparedView = {
  paymentId: string;
  transactionId: string;
  status: string;
  source: { amount: string; currency: string };
  destination: { amount: string; currency: string };
  fee: string;
  feeCurrency: string;
  spreadBps: number;
  intent: { chainId: string; spender: string; primaryType: string };
};

export type PrepareResult = { ok: true; prepared: PreparedView } | { ok: false; error: string };

/**
 * Quote + create the payment and the onchain (Permit2) intent. Real, but SAFE —
 * status is CRYPTO_FUNDS_PENDING and nothing has broadcast. Feeds the panel's
 * "prepared" step.
 */
export async function cpnPrepareAction(
  sourceAmountUsdc: string,
  corridorKey: string,
  sellerAddress?: string,
): Promise<PrepareResult> {
  try {
    const { quote, fees, spreadBps, payment, transaction } =
      await preparePayment(sourceAmountUsdc, corridorKey, sellerAddress);
    const m = transaction.messageToBeSigned;
    return {
      ok: true,
      prepared: {
        paymentId: payment.id,
        transactionId: transaction.id,
        status: payment.status,
        source: quote.sourceAmount,
        destination: quote.destinationAmount,
        fee: fees.total.amount,
        feeCurrency: fees.total.currency,
        spreadBps: Math.round(spreadBps),
        intent: {
          chainId: String(m.domain.chainId ?? ""),
          spender: String((m.message as Record<string, unknown>)?.spender ?? ""),
          primaryType: m.primaryType,
        },
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type BroadcastView = { transactionId: string; lifecycle: string[]; finalStatus: string };
export type BroadcastResult = { ok: true; result: BroadcastView } | { ok: false; error: string };

/**
 * Sign and BROADCAST a prepared payment — IRREVERSIBLE. The panel gates this
 * behind an explicit confirmation. Testnet funds, but the flow is real.
 */
export async function cpnBroadcastAction(paymentId: string): Promise<BroadcastResult> {
  try {
    const r = await broadcastPayment(paymentId);
    return { ok: true, result: { transactionId: r.transactionId, lifecycle: r.lifecycle, finalStatus: r.finalStatus } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Seller-signed path: the wallet holding the USDC authorizes the spend ──

export type IntentView = {
  /** CPN's raw EIP-712 JSON — normalize it in the browser before signing. */
  messageToBeSigned: unknown;
  /** What Permit2 must be allowed to pull, in USDC minor units. */
  permitAmountMinor: string;
};
export type IntentResult = { ok: true; intent: IntentView } | { ok: false; error: string };

/**
 * Hand the prepared intent to the browser so the seller's own wallet can sign
 * it. Read-only: this reveals what will be signed, it does not sign anything.
 */
export async function cpnIntentAction(paymentId: string): Promise<IntentResult> {
  const intent = preparedIntent(paymentId);
  if (!intent) return { ok: false, error: "Payment was never prepared (or the server restarted)." };
  return { ok: true, intent };
}

/**
 * Broadcast an intent signed by the seller's wallet — IRREVERSIBLE.
 *
 * Unlike `cpnBroadcastAction`, no server-held key participates: the signature
 * was produced in the browser and the Permit2 approval was the wallet's own
 * transaction.
 */
export async function cpnBroadcastSignedAction(paymentId: string, signature: Hex): Promise<BroadcastResult> {
  try {
    const r = await broadcastSignedPayment(paymentId, signature);
    return { ok: true, result: { transactionId: r.transactionId, lifecycle: r.lifecycle, finalStatus: r.finalStatus } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
