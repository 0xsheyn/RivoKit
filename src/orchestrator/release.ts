/**
 * Release: capture from escrow, then settle to the recipient's currency.
 *
 * THE GAP THIS CODE HAS TO OWN
 *
 * `SCENARIO.md` step 6 says that if the swap misses its floor, "funds stay safe
 * in escrow". That is not true, and pretending otherwise would hide a real
 * exposure. Capture is what moves funds OUT of escrow. After it succeeds the
 * money sits in the receiver's wallet as USDC; the swap is a separate
 * transaction against a separate protocol, and the two cannot be atomic.
 *
 * So there is a window — usually seconds — where:
 *   - the payer has paid
 *   - the escrow is settled and cannot be reversed by void or reclaim
 *   - the receiver holds USDC, not the EURC they were promised
 *
 * Nothing is lost in that window. What is not yet delivered is the CURRENCY
 * guarantee. This module reports that state honestly as `settlement_pending`
 * rather than calling the order released, so an operator can retry the swap
 * instead of discovering later that a "released" order never became EURC.
 *
 * Ordering the other way — swap first, then capture — does not work: the funds
 * are still in escrow at swap time, so there is nothing to swap.
 */
import type { Address, Hex } from "viem";
import type { Escrow } from "../escrow/operations.ts";
import type { PaymentInfo } from "../escrow/payment-info.ts";
import type { FxToken, SettlementFx } from "../settlement-fx/swap.ts";
import { FloorNotMetError } from "../settlement-fx/swap.ts";
import { netOfFee } from "../sdk/fee.ts";
import { assertReleaseProof, type ReleaseProof, type Wedge } from "./policy.ts";
import { assertTransition, type OrderState } from "./state-machine.ts";

export type ReleaseOutcome =
  | {
      status: "released";
      capturedMinor: bigint;
      eurcOutMinor: bigint;
      rebateMinor: bigint;
      // `| undefined` is required by exactOptionalPropertyTypes: the field may
      // be present and undefined, not merely absent.
      captureTxHash?: string | undefined;
      swapTxHash?: string | undefined;
      manualOverride: boolean;
    }
  | {
      /**
       * Capture succeeded, settlement did not. Funds are with the receiver as
       * the source token — safe, but not yet in the promised currency.
       */
      status: "settlement_pending";
      capturedMinor: bigint;
      captureTxHash?: string | undefined;
      reason: string;
      manualOverride: boolean;
    };

export type ReleaseDeps = {
  escrow: Escrow;
  fx: SettlementFx;
  /** Wallet that receives the capture and performs the swap. */
  settlementAddress: Address;
  tokenIn?: FxToken;
  tokenOut?: FxToken;
};

export type ReleaseRequest = {
  paymentInfo: PaymentInfo;
  /** Amount to capture, in minor units. */
  amountMinor: bigint;
  /** The floor: what the recipient is guaranteed, in tokenOut minor units. */
  priceOutMinor: bigint;
  wedge: Wedge;
  proof: ReleaseProof;
  currentState: OrderState;
  feeBps?: number;
  feeReceiver?: Address;
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export async function release(
  deps: ReleaseDeps,
  req: ReleaseRequest,
): Promise<ReleaseOutcome> {
  const tokenIn = deps.tokenIn ?? "USDC";
  const tokenOut = deps.tokenOut ?? "EURC";

  // 1. The host's release trigger must fit the wedge. Checked BEFORE anything
  //    moves — a rejected proof must not leave a half-finished release.
  const proofCheck = assertReleaseProof(req.wedge, req.proof);

  // 2. Refuse an illegal lifecycle jump here rather than letting the escrow
  //    revert. Capturing an unfunded order is a bug, not a chain error.
  assertTransition(req.currentState, "released");

  // 3. Capture: funds leave escrow. Past this line, void and reclaim are no
  //    longer available for the captured amount.
  const capture = await deps.escrow.capture(
    req.paymentInfo,
    req.amountMinor,
    req.feeBps ?? 0,
    req.feeReceiver ?? ZERO,
  );

  // 4. Settle into the recipient's currency, floored at the guaranteed price.
  //    Swap the POST-FEE remainder: the escrow already split the operator fee
  //    off at capture, so swapping the gross would try to move tokens the
  //    settlement wallet never received.
  const netMinor = netOfFee(req.amountMinor, req.feeBps ?? 0);
  try {
    const swap = await deps.fx.swapWithFloor({
      address: deps.settlementAddress,
      tokenIn,
      tokenOut,
      amountInMinor: netMinor,
      floorOutMinor: req.priceOutMinor,
    });

    return {
      status: "released",
      capturedMinor: req.amountMinor,
      eurcOutMinor: swap.amountOutMinor,
      rebateMinor: swap.rebateMinor,
      captureTxHash: capture.txHash,
      swapTxHash: swap.txHash,
      manualOverride: proofCheck.manualOverride,
    };
  } catch (e) {
    // The floor held — the recipient was never shortchanged. But the capture
    // already happened, so this is NOT "funds safe in escrow". Say so plainly.
    const reason =
      e instanceof FloorNotMetError
        ? `Floor ${req.priceOutMinor} not met; ${netMinor} ${tokenIn} sits at ${deps.settlementAddress}, not yet converted.`
        : `Settlement failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;

    return {
      status: "settlement_pending",
      capturedMinor: req.amountMinor,
      captureTxHash: capture.txHash,
      reason,
      manualOverride: proofCheck.manualOverride,
    };
  }
}

/**
 * Retry settlement for an order stuck at `settlement_pending`.
 *
 * Separate from `release` because capture must not run twice — the escrow would
 * reject a second capture beyond the authorized amount, but a retry that
 * re-entered `release` would also re-check the proof and the state transition,
 * both of which have already happened.
 */
export async function retrySettlement(
  deps: ReleaseDeps,
  req: { amountMinor: bigint; priceOutMinor: bigint },
): Promise<ReleaseOutcome> {
  const tokenIn = deps.tokenIn ?? "USDC";
  const tokenOut = deps.tokenOut ?? "EURC";

  try {
    const swap = await deps.fx.swapWithFloor({
      address: deps.settlementAddress,
      tokenIn,
      tokenOut,
      amountInMinor: req.amountMinor,
      floorOutMinor: req.priceOutMinor,
    });

    return {
      status: "released",
      capturedMinor: req.amountMinor,
      eurcOutMinor: swap.amountOutMinor,
      rebateMinor: swap.rebateMinor,
      // Must be returned: a payment row marked confirmed without a tx hash is
      // unverifiable against the chain, and `confirmed_has_tx` rejects it.
      swapTxHash: swap.txHash,
      manualOverride: false,
    };
  } catch (e) {
    return {
      status: "settlement_pending",
      capturedMinor: req.amountMinor,
      reason: String((e as Error)?.message ?? e).slice(0, 200),
      manualOverride: false,
    };
  }
}

export type { Hex };
