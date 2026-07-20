/**
 * AuthCaptureEscrow ABI — only the parts RivoKit calls.
 *
 * Field order in the PaymentInfo tuple is load-bearing: it feeds `abi.encode`
 * inside getHash, so any reordering silently changes every payment's identity.
 * Keep it aligned with src/escrow/payment-info.ts.
 */

export const PAYMENT_INFO_COMPONENTS = [
  { name: "operator", type: "address" },
  { name: "payer", type: "address" },
  { name: "receiver", type: "address" },
  { name: "token", type: "address" },
  { name: "maxAmount", type: "uint120" },
  { name: "preApprovalExpiry", type: "uint48" },
  { name: "authorizationExpiry", type: "uint48" },
  { name: "refundExpiry", type: "uint48" },
  { name: "minFeeBps", type: "uint16" },
  { name: "maxFeeBps", type: "uint16" },
  { name: "feeReceiver", type: "address" },
  { name: "salt", type: "uint256" },
] as const;

const paymentInfoInput = {
  name: "paymentInfo",
  type: "tuple",
  components: PAYMENT_INFO_COMPONENTS,
} as const;

export const ESCROW_ABI = [
  {
    type: "function",
    name: "getHash",
    stateMutability: "view",
    inputs: [paymentInfoInput],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "paymentState",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "hasCollectedPayment", type: "bool" },
      { name: "capturableAmount", type: "uint120" },
      { name: "refundableAmount", type: "uint120" },
    ],
  },
  {
    type: "function",
    name: "getTokenStore",
    stateMutability: "view",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "authorize",
    stateMutability: "nonpayable",
    inputs: [
      paymentInfoInput,
      { name: "amount", type: "uint256" },
      { name: "tokenCollector", type: "address" },
      { name: "collectorData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "capture",
    stateMutability: "nonpayable",
    inputs: [
      paymentInfoInput,
      { name: "amount", type: "uint256" },
      { name: "feeBps", type: "uint16" },
      { name: "feeReceiver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "charge",
    stateMutability: "nonpayable",
    inputs: [
      paymentInfoInput,
      { name: "amount", type: "uint256" },
      { name: "tokenCollector", type: "address" },
      { name: "collectorData", type: "bytes" },
      { name: "feeBps", type: "uint16" },
      { name: "feeReceiver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "void",
    stateMutability: "nonpayable",
    inputs: [paymentInfoInput],
    outputs: [],
  },
  {
    type: "function",
    name: "reclaim",
    stateMutability: "nonpayable",
    inputs: [paymentInfoInput],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [
      paymentInfoInput,
      { name: "amount", type: "uint256" },
      { name: "tokenCollector", type: "address" },
      { name: "collectorData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/**
 * Solidity signatures, as Circle's contractExecution API wants them.
 *
 * viem derives these from the ABI; Circle does not, so they are spelled out.
 * The tuple must be written inline and in the same order as above.
 */
const PI = "(address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256)";

export const ESCROW_SIGNATURES = {
  authorize: `authorize(${PI},uint256,address,bytes)`,
  capture: `capture(${PI},uint256,uint16,address)`,
  charge: `charge(${PI},uint256,address,bytes,uint16,address)`,
  void: `void(${PI})`,
  reclaim: `reclaim(${PI})`,
  refund: `refund(${PI},uint256,address,bytes)`,
} as const;
