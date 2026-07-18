/**
 * 8 status Tier-1. INVARIANT: status DITURUNKAN dari agregat leg Tier-2,
 * tidak pernah diset manual (CLAUDE.md invariant #4, PRD SM-1).
 */
export const PAYMENT_STATUSES = [
  "created",
  "authorized",
  "held",
  "action_required",
  "processing",
  "settled",
  "failed",
  "reversed",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Transisi legal (CONCEPT §8). Dari `settled` hanya ke `reversed`. */
export const LEGAL_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ["authorized", "failed"],
  authorized: ["held", "processing", "failed"],
  held: ["processing", "reversed"],
  action_required: ["processing", "failed"],
  processing: ["action_required", "settled", "failed"],
  settled: ["reversed"],
  failed: [],
  reversed: [],
};

export const TERMINAL_STATUSES: readonly PaymentStatus[] = ["failed", "reversed"];

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Event webhook — satu per status (PRD FR-WHK-1). */
export type PaymentEventType = `payment.${PaymentStatus}`;
