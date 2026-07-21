/**
 * Gasless funding — ERC-3009 `receiveWithAuthorization`.
 *
 * This is how a buyer funds an order without holding Arc's gas token. The buyer
 * SIGNS an authorization off-chain (no transaction, no gas), and the operator
 * relays it on-chain via the escrow's ERC3009PaymentCollector, paying the gas
 * itself. The buyer's USDC moves; the buyer never pays gas. That is the whole
 * point of the wedge assumption "payer is a crypto-native treasury holding USDC"
 * — they should not need a second, native token just to move the first.
 *
 * It is an operator-relay, NOT a generic paymaster (CLAUDE.md §1): the operator
 * is already in the loop as the party that drives every payment, so relaying the
 * collection costs nothing extra in trust. There is no separate sponsor.
 *
 * Two correctness pins:
 *   - The signed `value` is `maxAmount`, and `validBefore` is `preApprovalExpiry`
 *     — the authorization must not outlive the pre-approval window.
 *   - The `nonce` is the PAYER-AGNOSTIC hash (payer zeroed). The buyer signs
 *     before the escrow knows which address pays, and a single-use nonce is what
 *     makes funding replay-proof (PRD §10 invariant 4). Get this wrong and either
 *     the collection reverts or replay protection is lost.
 *
 * The EIP-712 domain is Arc USDC's own (`name: "USDC", version: "2"`), verified
 * against the live token — see arc-usdc-perilaku-terverifikasi.
 */
import type { Address, Hex } from "viem";
import { getPayerAgnosticHash, type PaymentInfo } from "./payment-info.ts";

export type ReceiveAuthorizationParams = {
  paymentInfo: PaymentInfo;
  chainId: number;
  escrowAddress: Address;
  /** ERC3009PaymentCollector — the `to` that receives the authorized transfer. */
  tokenCollector: Address;
  /** The USDC token contract (the EIP-712 verifying contract). */
  usdcAddress: Address;
  /** Override the token's EIP-712 domain if it ever differs from Arc USDC. */
  domainName?: string;
  domainVersion?: string;
};

/** The EIP-712 typed data a buyer signs to authorize a gasless collection. */
export type ReceiveAuthorizationTypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: { ReceiveWithAuthorization: ReadonlyArray<{ name: string; type: string }> };
  primaryType: "ReceiveWithAuthorization";
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
};

const RECEIVE_WITH_AUTHORIZATION_FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/**
 * Build the typed data for `receiveWithAuthorization`. Pure — pass it straight to
 * a wallet's `signTypedData`. Kept in one place so the three funding paths
 * (bridge, unified balance, direct) sign byte-identical authorizations.
 */
export function receiveAuthorizationTypedData(
  params: ReceiveAuthorizationParams,
): ReceiveAuthorizationTypedData {
  const { paymentInfo: pi } = params;
  return {
    domain: {
      name: params.domainName ?? "USDC",
      version: params.domainVersion ?? "2",
      chainId: params.chainId,
      verifyingContract: params.usdcAddress,
    },
    types: { ReceiveWithAuthorization: RECEIVE_WITH_AUTHORIZATION_FIELDS },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: pi.payer,
      to: params.tokenCollector,
      value: pi.maxAmount,
      validAfter: 0n,
      validBefore: BigInt(pi.preApprovalExpiry),
      nonce: getPayerAgnosticHash(pi, params.chainId, params.escrowAddress),
    },
  };
}
