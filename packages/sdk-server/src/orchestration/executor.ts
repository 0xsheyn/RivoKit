import type { FailureClass, Leg, SagaAction } from "@rivokit/core";
import { FAILURE_ACTION, LEG_REVERSIBILITY } from "@rivokit/core";

/**
 * Executor / Saga — pemilik transisi Tier-1.
 * Loop per-leg: execute (idempotent) → confirm → recover.
 */

export interface RecoveryDecision {
  readonly action: SagaAction;
  readonly reason: string;
}

/**
 * Forward-first: forward-retry selama leg masih MUNGKIN sukses;
 * compensate hanya bila mustahil (invariant #5).
 *
 * Pengecualian keras: leg irreversible (off-ramp) TIDAK BOLEH forward-retry
 * sebelum RECONCILE — retry buta berisiko payout ganda (PRD SG-3).
 */
export function decideRecovery(leg: Leg, failure: FailureClass): RecoveryDecision {
  const action = FAILURE_ACTION[failure];

  if (LEG_REVERSIBILITY[leg.type] === "irreversible" && action === "forward-retry") {
    return {
      action: "reconcile",
      reason: `leg ${leg.type} irreversible — RECONCILE wajib sebelum retry`,
    };
  }

  return { action, reason: `failure=${failure}` };
}

/** TODO(M1): jalankan saga di worker BullMQ; setiap leg idempotent. */
export function runSaga(): Promise<never> {
  throw new Error("not implemented: runSaga()");
}
