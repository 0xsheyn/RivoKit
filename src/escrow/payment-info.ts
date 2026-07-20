/**
 * PaymentInfo — the on-chain payment descriptor, and its hash.
 *
 * This struct is dictated by Commerce Payments Protocol, not by RivoKit. Its
 * field order and types must match AuthCaptureEscrow.PaymentInfo exactly: the
 * hash is computed by `abi.encode`, so reordering or widening a single field
 * silently produces a different hash.
 *
 * Why the hash matters twice over:
 *   1. It is the escrow's state key. Get it wrong and an authorized payment can
 *      never be captured — the funds sit until authorizationExpiry.
 *   2. With `payer` zeroed it is the ERC-3009 authorization nonce. That is what
 *      makes funding replay-proof (PRD §10 invariant 4).
 *
 * Reference: base/commerce-payments @ 3f77761, src/AuthCaptureEscrow.sol
 */
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from "viem";

export type PaymentInfo = {
  /** Drives the payment. Only this address may authorize/capture/void/refund. */
  operator: Address;
  /** Authorizes the payment. Only this address may reclaim after expiry. */
  payer: Address;
  /** Receives the payment, minus fees. */
  receiver: Address;
  token: Address;
  /** Max collectable, in minor units. uint120 on-chain. */
  maxAmount: bigint;
  /** After this, the payer's pre-approval can no longer authorize. uint48. */
  preApprovalExpiry: number;
  /** After this, capture is refused and the payer may reclaim. uint48. */
  authorizationExpiry: number;
  /** After this, refund is refused. uint48. */
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  /** Zero means the operator picks the fee receiver at capture time. */
  feeReceiver: Address;
  /** Entropy that makes otherwise-identical payments distinct. */
  salt: bigint;
};

/**
 * keccak256 of the struct signature, exactly as the contract declares it.
 * Any whitespace or type difference here changes every hash.
 */
export const PAYMENT_INFO_TYPEHASH = keccak256(
  toHex(
    "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)",
  ),
);

/** Tuple layout matching `abi.encode(PAYMENT_INFO_TYPEHASH, paymentInfo)`. */
const PAYMENT_INFO_PARAMS = parseAbiParameters(
  "bytes32, (address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt)",
);

const CHAIN_SCOPE_PARAMS = parseAbiParameters("uint256, address, bytes32");

/**
 * Reproduce `AuthCaptureEscrow.getHash` off-chain.
 *
 * Must be verified against the deployed contract rather than trusted — see
 * scripts/check-hash.mjs, which compares this against an eth_call for randomly
 * generated inputs.
 */
export function getPaymentInfoHash(
  paymentInfo: PaymentInfo,
  chainId: number,
  escrowAddress: Address,
): Hex {
  const structHash = keccak256(
    encodeAbiParameters(PAYMENT_INFO_PARAMS, [PAYMENT_INFO_TYPEHASH, paymentInfo]),
  );
  return keccak256(
    encodeAbiParameters(CHAIN_SCOPE_PARAMS, [BigInt(chainId), escrowAddress, structHash]),
  );
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * The ERC-3009 nonce: the payment hash with `payer` replaced by the zero
 * address.
 *
 * Payer-agnostic on purpose — the payer signs before the escrow knows which
 * address will actually pay, so the nonce cannot depend on it.
 */
export function getPayerAgnosticHash(
  paymentInfo: PaymentInfo,
  chainId: number,
  escrowAddress: Address,
): Hex {
  return getPaymentInfoHash(
    { ...paymentInfo, payer: ZERO_ADDRESS },
    chainId,
    escrowAddress,
  );
}
