import type { Fee, Money, Quote } from "@rivokit/core";

/** Default spread FX 50bps + off-ramp flat; P2P sesama mata uang gratis (F13). */
export const DEFAULT_FX_SPREAD_BPS = 50;
export const QUOTE_TTL_SECONDS = 45;

export interface QuoteInput {
  readonly from: Money;
  readonly toCurrency: Money["currency"];
  readonly midRate: string;
}

/**
 * Fee TIDAK PERNAH disembunyikan di rate — selalu muncul di `quote.fees[]`
 * dan sebagai entri ledger platform-fee eksplisit (invariant #8).
 *
 * TODO(M2): hitung dari mid-rate StableFX + tarif off-ramp CPN.
 */
export function buildQuote(_input: QuoteInput): Quote {
  throw new Error("not implemented: buildQuote()");
}

export function fxSpreadFee(_amount: Money, _bps: number): Fee {
  throw new Error("not implemented: fxSpreadFee()");
}
