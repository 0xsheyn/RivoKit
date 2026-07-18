import type { Leg, PaymentStatus, RoutePlan } from "@rivokit/core";
import { canTransition } from "@rivokit/core";

export class IllegalTransitionError extends Error {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(`Illegal payment transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** Penjaga transisi — satu-satunya pintu perubahan status Tier-1. */
export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export interface DerivationInput {
  readonly current: PaymentStatus;
  readonly legs: readonly Leg[];
  readonly routePlan: RoutePlan;
}

/**
 * Derivasi status Tier-1 dari agregat leg Tier-2 (invariant #4).
 * TODO(M1): lengkapi — `settled` hanya menyala saat leg TERAKHIR mencapai
 * finalitas penerima (kredit fiat dikonfirmasi / mint terkonfirmasi), PRD SM-3.
 */
export function derive(_input: DerivationInput): PaymentStatus {
  throw new Error("not implemented: derive()");
}
