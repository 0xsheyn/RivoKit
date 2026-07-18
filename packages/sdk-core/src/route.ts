import type { Money, MoneyState } from "./money.js";

/** Primitif = tepi dalam graf routing (CONCEPT §7). */
export type LegType = "bridge" | "escrow" | "fx" | "offramp" | "onramp" | "p2p";

export type LegStatus = "pending" | "executing" | "confirmed" | "failed" | "compensated";

/**
 * Reversibilitas menentukan aksi Saga. Leg `irreversible` (off-ramp)
 * TIDAK BOLEH forward-retry sebelum RECONCILE (PRD SG-3).
 */
export type Reversibility = "reversible" | "forward-recoverable" | "semi-final" | "irreversible";

export const LEG_REVERSIBILITY: Readonly<Record<LegType, Reversibility>> = {
  bridge: "forward-recoverable",
  escrow: "reversible",
  fx: "semi-final",
  offramp: "irreversible",
  onramp: "forward-recoverable",
  p2p: "forward-recoverable",
};

export interface RouteLeg {
  readonly type: LegType;
  readonly from: MoneyState;
  readonly to: MoneyState;
  readonly reversibility: Reversibility;
}

/** Keluaran Planner — fungsi MURNI, tanpa efek samping. */
export interface RoutePlan {
  readonly legs: readonly RouteLeg[];
  /** `true` bila rute wajib melewati hub Arc (Δcurrency ∨ Δform=fiat ∨ needsEscrow). */
  readonly hubRequired: boolean;
  readonly etaSeconds: number;
}

/** Klasifikasi kegagalan → aksi Saga (CONCEPT §10, PRD SG-2). */
export type FailureClass = "transient" | "needs-input" | "missing-ack" | "permanent";

export type SagaAction = "forward-retry" | "action-required" | "reconcile" | "compensate";

export const FAILURE_ACTION: Readonly<Record<FailureClass, SagaAction>> = {
  transient: "forward-retry",
  "needs-input": "action-required",
  "missing-ack": "reconcile",
  permanent: "compensate",
};

/** Fee selalu eksplisit di quote — tak pernah disembunyikan di rate (invariant #8). */
export interface Fee {
  readonly kind: "fx-spread" | "offramp-flat" | "network";
  readonly amount: Money;
  readonly description: string;
}

export interface Quote {
  readonly quoteId: string;
  readonly sourceDebit: Money;
  readonly destinationCredit: Money;
  /** Mid-rate, terpisah dari margin (yang hidup di `fees`). */
  readonly fxRate: string | null;
  readonly fees: readonly Fee[];
  readonly etaSeconds: number;
  readonly routePreview: RoutePlan;
  readonly expiresAt: string;
}
