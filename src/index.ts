/**
 * RivoKit — public entry point.
 *
 * Everything an integrating app is meant to touch is re-exported here, grouped
 * the way the README describes it. Deep imports into `src/**` still work but are
 * not part of the supported surface: they move without a version bump.
 *
 * WHAT THE HOST MUST BRING. `createRivoKit` is a composition root, not a
 * service. It holds no keys and opens no connections — the store, the escrow
 * sender, the FX client, the funding rails and the ERC-3009 signer are all
 * injected, because each of them needs a credential that belongs to the host's
 * environment (CLAUDE.md §0.1, §2). The wiring in `demo/lib/rivokit.server.ts`
 * is the reference composition, and `scripts/live-sdk.mjs` proves it on chain.
 *
 * SERVER-SIDE ONLY. Circle keys (`CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`,
 * `KIT_KEY`, `CIRCLE_CPN_KEY`) must never reach a browser bundle. The one thing
 * that is safe client-side is the payer's own signing: the ERC-3009 typed data
 * (`receiveAuthorizationTypedData`) and the funding rails that only need the
 * payer's wallet (bridge, unified balance — neither takes a kit key).
 */

/* ── The facade ───────────────────────────────────────────────────────────── */
export {
  createRivoKit,
  paymentInfoFromRecord,
  OperatorGasLowError,
  type RivoKit,
  type RivoKitConfig,
  type RivoKitDeps,
  type CreateOrderParams,
  type Order,
  type FundExecutor,
  type RebatePayer,
} from "./sdk/rivokit.ts";

/** Operator-fee arithmetic. The fee is grossed ONTO the payer, never taken out
 *  of the receiver's floor — see fee.ts for why that direction is mandatory. */
export { assertFeeBps, feeOf, grossUpForFee, netOfFee, InvalidFeeError } from "./sdk/fee.ts";

/* ── Escrow (Commerce Payments Protocol) ──────────────────────────────────── */
export { createEscrow, type Escrow, type Sender, type PaymentState } from "./escrow/operations.ts";
export {
  getPaymentInfoHash,
  getPayerAgnosticHash,
  ZERO_ADDRESS,
  PAYMENT_INFO_TYPEHASH,
  type PaymentInfo,
} from "./escrow/payment-info.ts";
/** The gasless collection primitive: the payer signs, the operator relays. */
export { receiveAuthorizationTypedData } from "./escrow/erc3009.ts";
export { ESCROW_ABI, ESCROW_SIGNATURES } from "./escrow/abi.ts";

/* ── Settlement FX (floored swap) ─────────────────────────────────────────── */
export {
  createSettlementFx,
  FloorNotMetError,
  NoRouteError,
  type SettlementFx,
  type SettlementFxConfig,
  type FxToken,
  type Quote,
  type FlooredSwapResult,
} from "./settlement-fx/swap.ts";
export { computeRebate, fromDecimalString, toDecimalString, MoneyFormatError } from "./settlement-fx/units.ts";

/* ── Funding rails ────────────────────────────────────────────────────────── */
export {
  createBridge,
  BridgeFailedError,
  BridgeStuckError,
  type Bridge,
  type BridgeParams,
  type BridgeResult,
} from "./funding/bridge.ts";
export {
  createUnifiedBalance,
  type UnifiedBalance,
  type UbBalance,
  type DepositParams,
  type SpendParams,
} from "./funding/unified-balance.ts";

/* ── Orchestrator ─────────────────────────────────────────────────────────── */
export { createOrderStore, type OrderStore, type OrderRecord, type PaymentKind } from "./orchestrator/order-store.ts";
export {
  ORDER_STATES,
  canTransition,
  assertTransition,
  isTerminal,
  isFunded,
  isCaptured,
  nextStates,
  InvalidStateTransition,
  type OrderState,
} from "./orchestrator/state-machine.ts";
export {
  WEDGES,
  RELEASE_PROOF_KINDS,
  expiriesFor,
  policyFor,
  timeoutPolicyFor,
  checkReleaseProof,
  assertReleaseProof,
  ReleaseRejected,
  type Wedge,
  type ReleaseProof,
  type TimeoutKind,
} from "./orchestrator/policy.ts";
export { reconcileOrder, reconcilePending } from "./orchestrator/reconcile.ts";

/* ── Events, compliance, payout ───────────────────────────────────────────── */
export {
  createEmitter,
  type Emitter,
  type OrderEventMap,
  type OrderEventName,
} from "./events/emitter.ts";
export {
  createComplianceGate,
  createCircleScreener,
  ComplianceBlockedError,
  type ComplianceGate,
} from "./events/compliance.ts";
export { parseWebhookEvent, verifyCircleSignature } from "./events/webhook.ts";
export { handleCircleWebhook } from "./events/webhook-handler.ts";
/** Labelled MOCK on purpose: RivoKit issues a payout INSTRUCTION, it does not
 *  execute fiat. The real fiat leg is the CPN ramp below, or the host's own. */
export { mockPayout, isMockPayout, type PayoutInstruction } from "./payout/mock-payout.ts";

/* ── Fiat off-ramp (CPN) — separate from the facade on purpose ────────────── */
export {
  createCpnRamp,
  type CpnRamp,
  type RampCorridor,
  type RampQuote,
  type PrepareParams,
} from "./ramp/cpn-ramp.ts";
/** Build the wallet-ready typed data from CPN's JSON `messageToBeSigned` — the
 *  browser side of a seller-signed cash-out (pair with `ramp.submitSigned`). */
export { normalizeTypedData, signPaymentIntent, type MessageToBeSigned } from "./ramp/cpn-sign.ts";
/** Webhook path. `verifyAndInterpretCpn` checks Circle's signature BEFORE any
 *  reducer sees the body; `applyPaymentEvent` only ever moves a payment forward. */
export {
  verifyAndInterpretCpn,
  interpretCpnEvent,
  applyPaymentEvent,
  canTransitionPayment,
  isPaymentTerminal,
  isPointOfNoReturn,
  rfiEffect,
  type CpnPaymentState,
  type CpnTransactionState,
  type CpnRfiState,
  type CpnEvent,
  type ApplyOutcome,
} from "./ramp/cpn-state.ts";

/* ── Arc constants & chain helpers ────────────────────────────────────────── */
export {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_RPC_URL,
  ARC_TESTNET_RPC_FALLBACKS,
  ARC_TESTNET_EXPLORER_URL,
  USDC_ADDRESS,
  EURC_ADDRESS,
  TOKEN_DECIMALS,
  NATIVE_GAS_DECIMALS,
  NATIVE_PER_ERC20_UNIT,
  GATEWAY_WALLET_ADDRESS,
  GATEWAY_MINTER_ADDRESS,
  PERMIT2_ADDRESS,
  arcTestnet,
} from "./constants/arc.ts";
export { arcTransport, sleep } from "./lib/rpc.ts";
/** Circle's DNS has been hijacked on at least one network; pin before any SDK
 *  call. Never disable TLS verification instead. */
export { installCircleDnsPinning } from "./lib/circle-dns.ts";
