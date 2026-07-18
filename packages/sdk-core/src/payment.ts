import type { Money, Preference } from "./money.js";
import type { LegStatus, LegType, RoutePlan } from "./route.js";
import type { PaymentStatus } from "./status.js";

/** Identitas — jangan campur (CLAUDE.md § Konvensi). */
export type PaymentId = string & { readonly __brand: "PaymentId" };
export type OrderId = string & { readonly __brand: "OrderId" };
export type LegId = string & { readonly __brand: "LegId" };
export type AccountId = string & { readonly __brand: "AccountId" };

export interface Account {
  readonly id: AccountId;
  readonly externalId: string;
  readonly country: string;
  readonly kycStatus: "pending" | "approved" | "rejected" | "rfi";
  readonly holdPreference: Preference;
  readonly receivePreference: Preference;
}

export interface Leg {
  readonly legId: LegId;
  readonly paymentId: PaymentId;
  readonly type: LegType;
  readonly status: LegStatus;
  readonly txHash: string | null;
  readonly attempts: number;
}

export interface Payment {
  readonly paymentId: PaymentId;
  /** Ada hanya pada rute berescrow. */
  readonly orderId: OrderId | null;
  readonly amount: Money;
  /** Set-once di `authorized` — read-only sesudahnya (CONCEPT §9). */
  readonly payer: string | null;
  readonly payee: string;
  readonly status: PaymentStatus;
  readonly routePlan: RoutePlan;
  readonly legs: readonly Leg[];
  readonly idempotencyKey: string;
}

/** Double-entry — kebenaran uang, berjangkar txHash (invariant #3). */
export interface LedgerEntry {
  readonly id: string;
  readonly paymentId: PaymentId;
  readonly account: string;
  readonly debit: Money | null;
  readonly credit: Money | null;
  readonly txHash: string | null;
}
