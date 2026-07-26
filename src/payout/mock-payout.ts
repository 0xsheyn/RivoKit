/**
 * Payout instruction — a STRUCTURED, MOCK, non-executing hand-off.
 *
 * RivoKit stops at the on-chain boundary. Once settlement delivers EURC to the
 * receiver on Arc, the fiat leg (EURC → EUR into a bank) belongs to the host,
 * who must run it through a licensed off-ramp (CLAUDE.md §0.6, §0.7). This module
 * does NOT move fiat and must never be mistaken for something that does — it
 * emits an instruction the host executes, clearly stamped as a mock.
 *
 * The label is not decoration. Golden rule §0.6 requires every mock to be
 * obvious in code, UI, and README; §0.7 forbids any claim that RivoKit performs
 * KYB/AML or fiat settlement. So `kind` is the literal `"mock"`, `executed` is
 * always false, and a disclaimer travels with every instruction. A caller that
 * wants to treat this as a real payout has to override those fields on purpose —
 * it cannot happen by accident.
 */
import type { Address } from "viem";

/** The only kind this module produces on testnet. There is no "real". */
export type PayoutKind = "mock";

export type PayoutInstruction = {
  kind: PayoutKind;
  /** Human/UI banner text. Always present, always "MOCK". */
  label: "MOCK";
  orderId: string;
  /** Who the fiat is owed to — the on-chain receiver of the EURC. */
  beneficiary: Address;
  /** What RivoKit actually delivered on-chain. */
  source: { currency: "EURC"; chain: "Arc_Testnet"; amountMinor: bigint; settlementTxHash?: string | undefined };
  /**
   * The fiat leg the HOST must execute. `amountMinor` is the nominal 1:1 EURC→EUR
   * figure BEFORE the off-ramp's own rate and fees — an estimate, not a promise.
   */
  target: { currency: "EUR"; amountMinor: bigint; estimated: true };
  /** Always false here: no fiat has moved. */
  executed: false;
  /** Explicit boundary statement carried with the instruction. */
  disclaimer: string;
  createdAt: number;
};

export type MockPayoutParams = {
  orderId: string;
  beneficiary: Address;
  /** EURC delivered to the receiver on Arc, in minor units (6dp). */
  eurcMinor: bigint;
  settlementTxHash?: string | undefined;
  /** Pass the current time in; this module stays pure (no Date.now). */
  now: number;
};

const DISCLAIMER =
  "MOCK — RivoKit does not execute the fiat leg. This instruction is handed to the host " +
  "to run through a licensed off-ramp (EURC→EUR). No fiat moves from here. " +
  "KYB/AML and fiat settlement are the host's responsibility.";

/**
 * Build a mock payout instruction from a settled order.
 *
 * EURC is a euro stablecoin, so the nominal EUR figure is 1:1 with the EURC
 * delivered — but it is flagged `estimated` because the host's off-ramp applies
 * its own rate and fees, which RivoKit neither sees nor controls.
 */
export function mockPayout(params: MockPayoutParams): PayoutInstruction {
  if (params.eurcMinor <= 0n) {
    throw new Error("mockPayout: eurcMinor must be > 0 — there is nothing to pay out");
  }
  return {
    kind: "mock",
    label: "MOCK",
    orderId: params.orderId,
    beneficiary: params.beneficiary,
    source: {
      currency: "EURC",
      chain: "Arc_Testnet",
      amountMinor: params.eurcMinor,
      settlementTxHash: params.settlementTxHash,
    },
    target: { currency: "EUR", amountMinor: params.eurcMinor, estimated: true },
    executed: false,
    disclaimer: DISCLAIMER,
    createdAt: params.now,
  };
}

/** True for anything this module produced — a guard for "never ship a mock as real". */
export function isMockPayout(p: PayoutInstruction): boolean {
  return p.kind === "mock" && p.label === "MOCK" && p.executed === false;
}
