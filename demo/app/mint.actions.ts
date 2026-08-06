"use server";

import { mintRedeem } from "../lib/mint.server.ts";
import { assertDecimalWithinCap, assertUnlocked, CAP_FIAT_MINOR } from "../lib/guard.server.ts";

export type MintBalanceView = { amount: string; currency: string };
export type MintPayoutView = {
  id: string; status: string; amount: string; currency: string; bankName: string;
  rail?: "sepa" | "wire"; createdAt?: string;
};
export type MintDepositView = {
  address: string;
  chains: string[];
  /** Present when Circle offers an EUR deposit address on Arc — the seller's
   *  floored EURC then needs no bridge to reach the Mint balance. */
  eurOnArc: { currency: string; chain: string; address: string } | null;
};

export type MintBalanceResult = { ok: true; balances: MintBalanceView[]; deposit: MintDepositView } | { ok: false; error: string };
export type MintRedeemResult = { ok: true; payout: MintPayoutView } | { ok: false; error: string };

/*
 * Reading the Mint balance and the redemption history moved to
 * `demo/lib/board.server.ts` (`GET /api/withdraw`). Two components used to ask
 * for the balance separately, through the Server Action queue, for the same
 * answer. Redeeming stays here — it moves fiat.
 */

/** Redeem `amount` of `currency` from the Mint balance to a linked bank. */
export async function mintRedeemAction(amount: string, currency = "EUR"): Promise<MintRedeemResult> {
  try {
    // `amount` used to travel from the caller straight into Circle's payouts
    // API with nothing between them — no gate, no ceiling, no validation. Both
    // controls apply here: fiat leaves the business account on this call.
    await assertUnlocked("Redeeming from Circle Mint");
    assertDecimalWithinCap(amount, CAP_FIAT_MINOR, "Mint redeem", 2);
    return { ok: true, payout: await mintRedeem(amount, currency) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
