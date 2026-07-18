import type { LedgerEntry, PaymentId } from "@rivokit/core";

/**
 * Ledger double-entry — KEBENARAN UANG, berjangkar txHash (invariant #3).
 * Setiap posting wajib seimbang: Σdebit == Σcredit per mata uang.
 */
export interface LedgerPort {
  post(entries: readonly LedgerEntry[]): Promise<void>;
  getByPayment(paymentId: PaymentId): Promise<readonly LedgerEntry[]>;
}

export class UnbalancedLedgerError extends Error {
  constructor(currency: string) {
    super(`Ledger posting tidak seimbang untuk ${currency}`);
    this.name = "UnbalancedLedgerError";
  }
}

/** TODO(M1): validasi keseimbangan sebelum post; tolak posting tanpa txHash on-chain. */
export function assertBalanced(_entries: readonly LedgerEntry[]): void {
  throw new Error("not implemented: assertBalanced()");
}
