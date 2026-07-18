import type { MoneyState, Preference, RouteLeg, RoutePlan } from "@rivokit/core";
import { LEG_REVERSIBILITY } from "@rivokit/core";

/** Hub settlement — seluruh otak (escrow, FX, ledger) hidup di Arc. */
export const HUB = "arc";

export interface PlanConstraints {
  /** Rute komersial (marketplace) butuh escrow; P2P murni tidak. */
  readonly needsEscrow: boolean;
}

export interface PlanInput {
  readonly source: MoneyState;
  readonly destination: Preference;
  /** Lokasi tujuan: chain spoke, `"arc"`, atau `"bank"` untuk fiat. */
  readonly destinationLocation: string;
  readonly constraints: PlanConstraints;
}

function leg(type: RouteLeg["type"], from: MoneyState, to: MoneyState): RouteLeg {
  return { type, from, to, reversibility: LEG_REVERSIBILITY[type] };
}

/** ETA jujur per leg (PRD UX-3): sub-detik on-Arc, menit–hari untuk fiat/cross-chain. */
const ETA_SECONDS: Record<RouteLeg["type"], number> = {
  bridge: 900,
  escrow: 2,
  fx: 5,
  offramp: 86_400,
  onramp: 86_400,
  p2p: 2,
};

/**
 * Planner — FUNGSI MURNI `(src, dst, prefs, constraints) → RoutePlan`.
 * Tanpa efek samping, tanpa I/O, tanpa clock (CLAUDE.md § Pemetaan modul).
 *
 * Urutan leg mengikuti kendala reversibilitas (CONCEPT §7):
 *   ingress-bridge → escrow(USDC) → FX → off-ramp/egress-bridge.
 * Leg irreversible (off-ramp) selalu TERAKHIR.
 */
export function plan(input: PlanInput): RoutePlan {
  const { source, destination, destinationLocation, constraints } = input;
  const legs: RouteLeg[] = [];

  const deltaCurrency = source.currency !== destination.currency;
  const deltaForm = destination.form === "fiat";
  const hubRequired = deltaCurrency || deltaForm || constraints.needsEscrow;

  let cursor: MoneyState = source;

  // 1. ingress-bridge — bawa dana ke hub bila rute butuh logika Arc.
  if (hubRequired && cursor.location !== HUB) {
    const next: MoneyState = { ...cursor, location: HUB };
    legs.push(leg("bridge", cursor, next));
    cursor = next;
  }

  // 2. escrow — menahan USDC (mata uang SUMBER). FX terjadi SETELAH release
  //    agar refund pra-rilis nol-slippage (invariant #10, R2/R3).
  if (constraints.needsEscrow) {
    legs.push(leg("escrow", cursor, cursor));
  }

  // 3. FX — penjual sebagai taker PvP; platform tak warehouse posisi.
  if (deltaCurrency) {
    const next: MoneyState = { ...cursor, currency: destination.currency };
    legs.push(leg("fx", cursor, next));
    cursor = next;
  }

  // 4a. off-ramp — IRREVERSIBLE, karenanya terakhir.
  if (deltaForm) {
    const next: MoneyState = { ...cursor, form: "fiat", location: destinationLocation };
    legs.push(leg("offramp", cursor, next));
    cursor = next;
  }
  // 4b. egress-bridge — tujuan stablecoin di chain lain.
  else if (cursor.location !== destinationLocation) {
    const next: MoneyState = { ...cursor, location: destinationLocation };
    legs.push(leg("bridge", cursor, next));
    cursor = next;
  }

  // Transfer P2P sesama mata uang & lokasi, tanpa escrow.
  if (legs.length === 0) {
    legs.push(leg("p2p", cursor, cursor));
  }

  return {
    legs,
    hubRequired,
    etaSeconds: legs.reduce((sum, l) => sum + ETA_SECONDS[l.type], 0),
  };
}
