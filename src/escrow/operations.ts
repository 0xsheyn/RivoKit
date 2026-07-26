/**
 * Escrow operations — the five lifecycle calls RivoKit wraps.
 *
 * Access control is not ours to choose; the contract enforces it:
 *   authorize / capture / charge / void / refund  →  only paymentInfo.operator
 *   reclaim                                        →  only paymentInfo.payer
 *
 * That split is why this module takes TWO senders. The operator is a
 * server-side signer (a Circle Developer-Controlled wallet); the payer signs in
 * their own wallet. A single sender abstraction would hide a real constraint:
 * RivoKit can never reclaim on a payer's behalf.
 */
import { type Address, type Hex, type PublicClient } from "viem";
import { ESCROW_ABI } from "./abi.ts";
import { type PaymentInfo } from "./payment-info.ts";

/** Sends a state-changing call and resolves once it has settled on-chain. */
export type Sender = (args: {
  functionName: string;
  args: readonly unknown[];
}) => Promise<{ txHash: Hex }>;

export type PaymentState = {
  hasCollectedPayment: boolean;
  capturableAmount: bigint;
  refundableAmount: bigint;
};

export type EscrowConfig = {
  escrowAddress: Address;
  publicClient: PublicClient;
  /** Signs as paymentInfo.operator. */
  operator: Sender;
  /** Signs as paymentInfo.payer. Only needed for reclaim. */
  payer?: Sender;
};

export class EscrowOperationError extends Error {
  // Assigned in the body, not via parameter properties: Node runs .ts files in
  // strip-only mode, which rejects `constructor(readonly x: string)`.
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = "EscrowOperationError";
    this.operation = operation;
  }
}

export function createEscrow(config: EscrowConfig) {
  const { escrowAddress, publicClient, operator, payer } = config;

  // viem types readContract against the literal ABI, which a generic string
  // helper cannot satisfy. The cast is confined here; every caller below is
  // typed, so the ABI still guards the call sites that matter.
  const read = <T>(functionName: string, args: readonly unknown[]) =>
    publicClient.readContract({
      address: escrowAddress,
      abi: ESCROW_ABI,
      functionName,
      args,
    } as never) as Promise<T>;

  return {
    /** On-chain hash. Prefer the local computation; use this to cross-check. */
    getHash: (paymentInfo: PaymentInfo) => read<Hex>("getHash", [paymentInfo]),

    getTokenStore: (operatorAddress: Address) =>
      read<Address>("getTokenStore", [operatorAddress]),

    async getPaymentState(paymentInfoHash: Hex): Promise<PaymentState> {
      const [hasCollectedPayment, capturableAmount, refundableAmount] = await read<
        [boolean, bigint, bigint]
      >("paymentState", [paymentInfoHash]);
      return { hasCollectedPayment, capturableAmount, refundableAmount };
    },

    /** Pull funds from the payer into escrow. Reverts if already collected. */
    authorize: (
      paymentInfo: PaymentInfo,
      amount: bigint,
      tokenCollector: Address,
      collectorData: Hex,
    ) =>
      operator({
        functionName: "authorize",
        args: [paymentInfo, amount, tokenCollector, collectorData],
      }),

    /**
     * Release escrowed funds to the receiver. Partial captures are allowed and
     * may be called repeatedly up to the authorized amount.
     */
    capture: (
      paymentInfo: PaymentInfo,
      amount: bigint,
      feeBps: number,
      feeReceiver: Address,
    ) =>
      operator({
        functionName: "capture",
        args: [paymentInfo, amount, feeBps, feeReceiver],
      }),

    /** authorize + capture atomically — the `direct` settle mode. */
    charge: (
      paymentInfo: PaymentInfo,
      amount: bigint,
      tokenCollector: Address,
      collectorData: Hex,
      feeBps: number,
      feeReceiver: Address,
    ) =>
      operator({
        functionName: "charge",
        args: [paymentInfo, amount, tokenCollector, collectorData, feeBps, feeReceiver],
      }),

    /**
     * Cancel a live authorization and return escrowed funds to the payer.
     *
     * This is the CHEAP cancellation path: the money is still in escrow, so
     * nothing is pulled from the operator. Prefer it over refund whenever the
     * payment has not been captured yet.
     */
    void: (paymentInfo: PaymentInfo) =>
      operator({ functionName: "void", args: [paymentInfo] }),

    /**
     * Payer-initiated recovery after authorizationExpiry.
     *
     * RivoKit cannot perform this — the contract requires msg.sender to be the
     * payer. It exists so a payer is never dependent on the operator staying
     * online; that independence is what makes the escrow non-custodial in
     * practice, not just in description.
     */
    reclaim: (paymentInfo: PaymentInfo) => {
      if (!payer) {
        throw new EscrowOperationError(
          "reclaim",
          "needs the payer as sender — only the payer may reclaim; the operator cannot stand in",
        );
      }
      return payer({ functionName: "reclaim", args: [paymentInfo] });
    },

    /**
     * Return already-captured funds to the payer.
     *
     * COSTS THE OPERATOR: OperatorRefundCollector pulls the tokens from the
     * operator's own balance, so the operator must hold them and must have
     * granted the collector an ERC-20 allowance. Captured funds are NOT
     * clawed back from the receiver.
     */
    refund: (
      paymentInfo: PaymentInfo,
      amount: bigint,
      refundCollector: Address,
      collectorData: Hex = "0x",
    ) =>
      operator({
        functionName: "refund",
        args: [paymentInfo, amount, refundCollector, collectorData],
      }),
  };
}

export type Escrow = ReturnType<typeof createEscrow>;
