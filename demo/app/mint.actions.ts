"use server";

import { mintBalance, mintDepositInfo, mintRedeem } from "../lib/mint.server.ts";

export type MintBalanceView = { amount: string; currency: string };
export type MintPayoutView = { id: string; status: string; amount: string; currency: string; bankName: string };
export type MintDepositView = { address: string; chains: string[] };

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

/** Redeem `amount` (USD in sandbox) from the Mint balance to a bank. */
export async function mintRedeemAction(amount: string): Promise<MintRedeemResult> {
  try {
    return { ok: true, payout: await mintRedeem(amount) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
