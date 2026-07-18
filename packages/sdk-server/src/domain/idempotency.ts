import type { PaymentId } from "@rivokit/core";

/**
 * Setiap operasi pengubah-dana WAJIB idempotent (invariant #5).
 * Host yang generate `Idempotency-Key`; replay = no-op yang mengembalikan
 * respons tersimpan (PRD FR-PAY-4).
 */
export interface IdempotencyStore {
  /** `null` bila key baru; jika ada, kembalikan respons tersimpan tanpa eksekusi ulang. */
  lookup(key: string): Promise<{ paymentId: PaymentId; responseHash: string } | null>;
  record(key: string, paymentId: PaymentId, responseHash: string): Promise<void>;
}
