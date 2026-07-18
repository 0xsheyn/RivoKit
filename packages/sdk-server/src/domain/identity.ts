import type { Account, AccountId } from "@rivokit/core";

/**
 * Identity — binding `walletAddress ↔ accountId (ter-KYC)` adalah FONDASI
 * atribusi pembayaran (CONCEPT §9).
 */
export interface IdentityStore {
  createAccount(input: { externalId: string; country: string }): Promise<Account>;
  bindWallet(accountId: AccountId, address: string): Promise<void>;
  resolveByAddress(address: string): Promise<Account | null>;
}
