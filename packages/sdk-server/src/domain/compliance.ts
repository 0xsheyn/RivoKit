import type { Account, AccountId } from "@rivokit/core";

/**
 * KYC dipicu DI DEPAN — di `accounts.create` atau nilai-masuk pertama,
 * BUKAN saat withdraw (invariant #9, R4).
 * MVP: stub yang memicu di titik yang benar (PRD NG5).
 */
export interface CompliancePort {
  startKyc(accountId: AccountId): Promise<{ status: Account["kycStatus"] }>;
  getStatus(accountId: AccountId): Promise<{ status: Account["kycStatus"] }>;
}
