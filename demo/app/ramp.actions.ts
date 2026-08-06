"use server";

import type { Hex } from "viem";
import {
  broadcastPayment,
  broadcastSignedPayment,
  getCpnRamp,
  preparedIntent,
  preparePayment,
} from "../lib/cpn.server.ts";
import {
  assertDecimalWithinCap,
  assertUnlocked,
  CAP_TOKEN_MINOR,
} from "../lib/guard.server.ts";

/*
 * The reads that used to live here — corridors, the seller balance, the
 * cash-out history — moved to `demo/lib/board.server.ts` and are served by
 * `GET /api/withdraw`. They were Server Actions, which meant three POSTs the
 * App Router ran one after another before the withdraw page could show
 * anything. What stays here is what a Server Action is for: the steps that
 * move money.
 */

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
    // Gated even though prepare moves nothing: it creates a real CPN payment
    // against the seller's address and starts a 30–60s quote clock, and it is
    // the step `cpnBroadcastAction` later spends. The cap is on the amount a
    // caller supplies, which until now went straight to the quote.
    await assertUnlocked("Preparing a cash-out");
    assertDecimalWithinCap(sourceAmountUsdc, CAP_TOKEN_MINOR, "Cash-out");

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
    // THE one that mattered. This signs with a server-held key, so anyone able
    // to POST to this endpoint could spend the seller's USDC irreversibly — and
    // a Server Action's id ships in the bundle handed to every visitor, so the
    // panel's confirmation dialog never stood between them and it.
    await assertUnlocked("Broadcasting a cash-out");
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
  const intent = await preparedIntent(paymentId);
  if (!intent) {
    return { ok: false, error: "No intent to sign for this payment — prepare a new cash-out." };
  }
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
    // Defence in depth rather than the load-bearing control: this path cannot be
    // driven by a stranger anyway, because the signature has to come from the
    // wallet that holds the USDC. Gated for consistency, so "which broadcast is
    // protected?" has one answer instead of two.
    await assertUnlocked("Broadcasting a wallet-signed cash-out");
    const r = await broadcastSignedPayment(paymentId, signature);
    return { ok: true, result: { transactionId: r.transactionId, lifecycle: r.lifecycle, finalStatus: r.finalStatus } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
