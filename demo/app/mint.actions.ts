"use server";

import { mintBalance, mintDepositInfo, mintPayouts, mintRedeem } from "../lib/mint.server.ts";

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

/** The Circle Mint account's redeemable balance. */
export async function mintBalanceAction(): Promise<MintBalanceResult> {
  try {
    const [balances, deposit] = await Promise.all([mintBalance(), mintDepositInfo()]);
    return { ok: true, balances, deposit };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type MintHistoryResult = { ok: true; payouts: MintPayoutView[] } | { ok: false; error: string };

/** Past Circle Mint redemptions, newest first — the panel's history. */
export async function mintHistoryAction(limit = 8): Promise<MintHistoryResult> {
  try {
    return { ok: true, payouts: await mintPayouts(limit) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Redeem `amount` of `currency` from the Mint balance to a linked bank. */
export async function mintRedeemAction(amount: string, currency = "EUR"): Promise<MintRedeemResult> {
  try {
    return { ok: true, payout: await mintRedeem(amount, currency) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
