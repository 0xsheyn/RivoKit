/**
 * Payout instruction — a STRUCTURED, MOCK, non-executing hand-off.
 *
 * This is the payout an order gets when no rail is wired: settlement delivered
 * EURC on Arc and the fiat leg belongs to the host, who must run it through a
 * licensed off-ramp (CLAUDE.md §0.6, §0.7). This module does NOT move fiat and
 * must never be mistaken for something that does — it emits an instruction the
 * host executes, clearly stamped as a mock.
 *
 * The label is not decoration. Golden rule §0.6 requires every mock to be
 * obvious in code, UI, and README; §0.7 forbids any claim that RivoKit performs
 * KYB/AML or fiat settlement. So `kind` is the literal `"mock"`, `executed` is
 * always false, `reference` is null, and a disclaimer travels with every
 * instruction. A caller that wants to treat this as a real payout has to
 * override those fields on purpose — it cannot happen by accident.
 *
 * The executing counterpart lives in `./cpn-payout.ts`, and the shape they both
 * share is in `./instruction.ts`.
 */
import type { Address } from "viem";
import type { PayoutInstruction } from "./instruction.ts";

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
    // Same 6-decimal scale as the EURC it mirrors: nothing has been quoted, so
    // there is no rail scale to convert into yet.
    target: { currency: "EUR", amountMinor: params.eurcMinor, scale: 6, estimated: true },
    executed: false,
    reference: null,
    disclaimer: DISCLAIMER,
    createdAt: params.now,
  };
}

/* Re-exported so existing importers of this module keep working. The
   definitions now live in ./instruction.ts, next to the live payout they share
   a shape with. */
export {
  isMockPayout,
  isLivePayout,
  toPayoutWire,
  fromPayoutWire,
  type PayoutKind,
  type PayoutInstruction,
  type PayoutInstructionWire,
} from "./instruction.ts";
