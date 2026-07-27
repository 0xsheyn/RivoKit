/**
 * RivoKit — the public SDK surface a host embeds.
 *
 * This is the one object the whole flow runs through (Phase 5 exit criterion).
 * It owns nothing that moves money; it COMPOSES the proven modules and owns the
 * things a facade should: state-machine transitions, host-facing events, the
 * mock payout hand-off, and the compliance gate that runs before funds move.
 * The chain work stays in the domain modules — escrow (CPP), settlement-fx
 * (StableFX), funding (bridge / unified balance) — and the money-moving,
 * key-signing step is INJECTED, because who signs and how is the host's
 * environment, not the orchestrator's business (CLAUDE.md §2).
 *
 * Money is bigint minor units throughout; the wire type `Order` stringifies it
 * at the boundary, matching API.md (all amounts are strings there).
 */
import type { Address, Hex } from "viem";
import type { Escrow } from "../escrow/operations.ts";
import { getPaymentInfoHash, ZERO_ADDRESS, type PaymentInfo } from "../escrow/payment-info.ts";
import type { SettlementFx, FxToken } from "../settlement-fx/swap.ts";
import type { OrderRecord, OrderStore } from "../orchestrator/order-store.ts";
import { isCaptured, type OrderState } from "../orchestrator/state-machine.ts";
import { expiriesFor, timeoutPolicyFor, type ReleaseProof, type Wedge } from "../orchestrator/policy.ts";
import { release as runRelease } from "../orchestrator/release.ts";
import { refund as runRefund } from "../orchestrator/refund.ts";
import type { Bridge, BridgeParams } from "../funding/bridge.ts";
import { createEmitter, type Emitter } from "../events/emitter.ts";
import type { ComplianceGate } from "../events/compliance.ts";
import { mockPayout, type PayoutInstruction } from "../payout/mock-payout.ts";
import { assertFeeBps, grossUpForFee, InvalidFeeError } from "./fee.ts";

/** Public order shape — money as strings, per API.md. */
export type Order = {
  id: string;
  payer: string;
  receiver: string;
  priceEUR: string;
  bufferBps: number;
  usdcAmount: string | null;
  receivingChain: string;
  mode: "escrow" | "direct";
  wedge: Wedge;
  state: OrderState;
  createdAt: string;
  fundedAt: string | null;
  settledAt: string | null;
};

export type CreateOrderParams = {
  payer: Address;
  receiver: Address;
  /** micro-EURC guaranteed to the receiver. */
  priceEURMinor: bigint;
  receivingChain: string;
  wedge: Wedge;
  mode?: "escrow" | "direct";
  bufferBps?: number;
  /** Operator fee in bps for this order; falls back to `config.feeBps`. */
  feeBps?: number;
  /** Where the fee lands; falls back to `config.feeReceiver`. */
  feeReceiver?: Address;
};

/**
 * Moves the payer's USDC onto Arc and authorizes it into escrow. Injected: it
 * needs the payer's signature and the funding rail (bridge or unified balance),
 * both of which live in the host's environment. Returns the escrow authorize tx.
 */
export type FundExecutor = (args: {
  order: OrderRecord;
  paymentInfo: PaymentInfo;
  hash: Hex;
  /**
   * A pre-obtained ERC-3009 authorization signature. When present (e.g. the buyer
   * signed in their own browser wallet), the executor relays it instead of signing
   * with a host-held key. Absent for the default server-signed path.
   */
  signature?: Hex;
}) => Promise<{ fundingTxHash?: string; authorizeTxHash: string }>;

/**
 * Deliver the settlement surplus (rebate) back to the payer.
 *
 * The seller was promised only the floor price; anything the swap yields above
 * it is the buffer the payer overpaid to absorb rate drift, and it is owed back
 * to them (PRD §10 invariant 6). This step is INJECTED because it moves EURC out
 * of the settlement wallet and so needs that wallet's signer, which is the host's
 * environment, not the orchestrator's (CLAUDE.md §2, §5). Omit it and the rebate
 * is still computed, stored, and reported — just not delivered; the seller keeps
 * the surplus, which is the prior behaviour.
 */
export type RebatePayer = (args: {
  orderId: string;
  /** The payer, who overpaid the buffer and is owed the surplus. */
  to: Address;
  amountMinor: bigint;
}) => Promise<{ txHash: string }>;

export type RivoKitConfig = {
  chainId: number;
  escrowAddress: Address;
  /** The operator that drives every payment (authorize/capture/void/refund). */
  operator: Address;
  /** The escrow token — USDC on Arc. */
  token: Address;
  refundCollector: Address;
  /** Wallet that receives capture and runs the swap — the receiver on Arc. */
  settlementAddress: Address;
  /** Circle chain identifier for compliance screening, e.g. "ARC-TESTNET". */
  screeningChain?: string;
  tokenIn?: FxToken;
  tokenOut?: FxToken;
  bufferBps?: number;
  /**
   * Operator fee in bps, withheld by the escrow at capture. This is how the
   * gasless relay pays for itself: the operator funds gas for authorize,
   * capture, void and refund, and on Arc that gas is USDC. Default 0 — the
   * operator subsidises every order, which is fine for a demo and not for
   * anything else.
   *
   * Grossed up onto what the payer authorizes (see ./fee.ts), so the seller's
   * floor is never funded out of. Requires `feeReceiver`.
   */
  feeBps?: number;
  feeReceiver?: Address;
  /**
   * Refuse to create orders once the operator's gas balance drops below this
   * (wei — Arc's native USDC has 18 decimals as gas, 6 as ERC-20). Needs
   * `deps.operatorGas`. Failing at checkout with a clear reason beats failing
   * mid-flight with an order stuck in funding_pending.
   */
  minOperatorGasWei?: bigint;
};

export type RivoKitDeps = {
  store: OrderStore;
  escrow: Escrow;
  fx: SettlementFx;
  bridge: Bridge;
  fund: FundExecutor;
  /** Returns the settlement surplus to the payer. Omit to leave it with the seller. */
  payRebate?: RebatePayer | undefined;
  config: RivoKitConfig;
  compliance?: ComplianceGate;
  emitter?: Emitter;
  /**
   * The operator's native gas balance, in wei. Injected because reading it needs
   * a chain client, which lives in the host's environment. Paired with
   * `config.minOperatorGasWei` to gate `createOrder`.
   */
  operatorGas?: () => Promise<bigint>;
  /** Injected for determinism in tests. */
  now?: () => number;
  salt?: () => bigint;
  /** Arc→receivingChain bridge params for a refund; omit when refund stays on Arc. */
  refundBridgeParams?: (order: OrderRecord) => BridgeParams | undefined;
};

const DEFAULT_BUFFER_BPS = 150;

/**
 * The operator's gas balance fell below the configured floor, so the gasless
 * relay cannot be honoured. Thrown at `createOrder` — before the payer commits
 * anything — rather than letting authorize fail after they have signed.
 */
export class OperatorGasLowError extends Error {
  readonly code = "OPERATOR_GAS_LOW";
  readonly balanceWei: bigint;
  readonly requiredWei: bigint;
  readonly operator: Address;

  constructor(balanceWei: bigint, requiredWei: bigint, operator: Address) {
    super(
      `Operator ${operator} has ${balanceWei} wei of gas left, below the ${requiredWei} wei floor. ` +
        "New orders are refused: the operator pays for the gasless relay, and on Arc that gas is USDC. Top it up first.",
    );
    this.name = "OperatorGasLowError";
    this.balanceWei = balanceWei;
    this.requiredWei = requiredWei;
    this.operator = operator;
  }
}

function toOrder(r: OrderRecord): Order {
  return {
    id: r.id,
    payer: r.payer,
    receiver: r.receiver,
    priceEUR: r.price_eur,
    bufferBps: r.buffer_bps,
    usdcAmount: r.usdc_amount,
    receivingChain: r.receiving_chain,
    mode: r.mode,
    wedge: r.wedge,
    state: r.state,
    createdAt: r.created_at,
    fundedAt: r.funded_at,
    settledAt: r.settled_at,
  };
}

const secondsFromIso = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

/** Rebuild the on-chain PaymentInfo from a stored order — its fields are all persisted. */
export function paymentInfoFromRecord(r: OrderRecord): PaymentInfo {
  return {
    operator: r.operator as Address,
    payer: r.payer as Address,
    receiver: r.receiver as Address,
    token: r.token as Address,
    maxAmount: BigInt(r.max_amount),
    preApprovalExpiry: secondsFromIso(r.pre_approval_expiry),
    authorizationExpiry: secondsFromIso(r.authorization_expiry),
    refundExpiry: secondsFromIso(r.refund_expiry),
    minFeeBps: r.min_fee_bps,
    maxFeeBps: r.max_fee_bps,
    feeReceiver: r.fee_receiver as Address,
    salt: BigInt(r.salt),
  };
}

export function createRivoKit(deps: RivoKitDeps) {
  const emitter = deps.emitter ?? createEmitter();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const salt =
    deps.salt ??
    (() => BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`));
  const { config } = deps;
  const tokenIn = config.tokenIn ?? "USDC";
  const tokenOut = config.tokenOut ?? "EURC";

  /**
   * Refuse new orders when the operator can no longer pay for the relay.
   *
   * Gasless means the operator, not the payer, funds every escrow call. When
   * that balance runs dry the failure surfaces mid-flight — the payer has signed,
   * the order sits in funding_pending, and nothing on-chain explains why. Better
   * to refuse at checkout, while nothing has moved.
   */
  async function assertOperatorCanRelay(): Promise<void> {
    const floor = config.minOperatorGasWei;
    if (!deps.operatorGas || floor == null) return;
    const balance = await deps.operatorGas();
    if (balance < floor) throw new OperatorGasLowError(balance, floor, config.operator);
  }

  async function get(orderId: string): Promise<OrderRecord> {
    const r = await deps.store.get(orderId);
    if (!r) throw new Error(`RivoKit: no such order ${orderId}`);
    return r;
  }

  return {
    on: emitter.on,
    off: emitter.off,

    /**
     * Read the mock payout instruction emitted for a settled order, if any.
     *
     * Reads the store rather than a process-local cache: the host asks for this
     * from a later request, and an in-memory answer would be `null` after any
     * restart — indistinguishable from "nothing is owed".
     */
    payoutFor: (orderId: string): Promise<PayoutInstruction | null> =>
      deps.store.getPayout(orderId),

    /** FX quote without executing. Money as strings, like every other wire value. */
    async estimateSwap(params: { address: string; amountInMinor: bigint }): Promise<{
      amountInMinor: string;
      amountOutMinor: string;
      stopLimitMinor: string | null;
      fees: ReadonlyArray<{ token: string; amount: string | null; type: string }>;
    }> {
      const q = await deps.fx.quote({ address: params.address, tokenIn, tokenOut, amountInMinor: params.amountInMinor });
      return {
        amountInMinor: q.amountInMinor.toString(),
        amountOutMinor: q.amountOutMinor.toString(),
        stopLimitMinor: q.stopLimitMinor === null ? null : q.stopLimitMinor.toString(),
        fees: q.fees,
      };
    },

    /**
     * Build an order and lock the FX quote. Screens the payer BEFORE anything is
     * stored, so a blocked address never becomes a fundable order.
     */
    async createOrder(params: CreateOrderParams): Promise<Order> {
      // Gas first: the operator relays every escrow call, so an operator that
      // cannot pay gas turns a new order into one that will stall after the
      // payer has already committed funds.
      await assertOperatorCanRelay();

      if (deps.compliance) {
        const chain = config.screeningChain ?? "ARC-TESTNET";
        await deps.compliance.assertAllowed(params.payer, chain, "funding");
        await deps.compliance.assertAllowed(params.receiver, chain, "payout");
      }

      const bufferBps = params.bufferBps ?? config.bufferBps ?? DEFAULT_BUFFER_BPS;
      const feeBps = params.feeBps ?? config.feeBps ?? 0;
      const feeReceiver = params.feeReceiver ?? config.feeReceiver ?? ZERO_ADDRESS;
      assertFeeBps(feeBps);
      if (feeBps > 0 && feeReceiver === ZERO_ADDRESS) {
        throw new InvalidFeeError("feeBps > 0 but feeReceiver is empty — the fee would burn to the zero address.");
      }

      // Invert the settlement quote to find how much USDC clears priceEUR + buffer.
      const { amountInMinor: netUsdcAmount } = await deps.fx.lockQuote({
        address: params.payer,
        tokenIn,
        tokenOut,
        priceOutMinor: params.priceEURMinor,
        bufferBps,
        probeInMinor: params.priceEURMinor, // ~1:1 stablecoins; a probe near value
      });

      // The payer authorizes the fee ON TOP of the net, so what the escrow hands
      // the receiver still clears priceEUR + buffer and the floored swap holds.
      const usdcAmount = grossUpForFee(netUsdcAmount, feeBps);

      const t = now();
      const exp = expiriesFor(params.wedge, t);
      const paymentInfo: PaymentInfo = {
        operator: config.operator,
        payer: params.payer,
        receiver: params.receiver,
        token: config.token,
        maxAmount: usdcAmount,
        preApprovalExpiry: exp.preApprovalExpiry,
        authorizationExpiry: exp.authorizationExpiry,
        refundExpiry: exp.refundExpiry,
        // Pinned, not a range: the payer authorizes exactly the fee they were
        // quoted, so the operator cannot capture with a larger one later.
        minFeeBps: feeBps,
        maxFeeBps: feeBps,
        feeReceiver,
        salt: salt(),
      };
      const hash = getPaymentInfoHash(paymentInfo, config.chainId, config.escrowAddress);

      const id = `ord_${t}_${Math.floor(Number(salt() % 1_000_000n))}`;
      const record = await deps.store.create({
        id,
        paymentInfo,
        priceEURMinor: params.priceEURMinor,
        usdcAmountMinor: usdcAmount,
        bufferBps,
        receivingChain: params.receivingChain,
        mode: params.mode ?? "escrow",
        wedge: params.wedge,
        timeoutKind: timeoutPolicyFor(params.wedge),
        timeoutDeadline: exp.authorizationExpiry,
        paymentInfoHash: hash,
      });
      return toOrder(record);
    },

    /**
     * Move USDC to Arc and authorize into escrow. Emits funding_pending → funded.
     * `opts.signature` carries a buyer-signed ERC-3009 authorization (e.g. from a
     * browser wallet); omit it for the default host-signed path.
     */
    async fund(orderId: string, opts?: { signature?: Hex }): Promise<void> {
      let order = await get(orderId);
      const paymentInfo = paymentInfoFromRecord(order);
      const hash = getPaymentInfoHash(paymentInfo, config.chainId, config.escrowAddress);

      if (order.state === "created") {
        order = await deps.store.transition(orderId, "funding_pending");
        emitter.emit("funding_pending", { orderId });
      }

      const res = await deps.fund({ order, paymentInfo, hash, ...(opts?.signature ? { signature: opts.signature } : {}) });
      await deps.store.recordPaymentIdempotent({
        orderId, nonce: `${hash}:authorize`, kind: "authorize",
        status: "confirmed", txHash: res.authorizeTxHash, chain: "Arc_Testnet", amountMinor: paymentInfo.maxAmount,
      });

      order = await get(orderId);
      if (order.state === "funding_pending") {
        await deps.store.transition(orderId, "funded", { fundedAt: new Date() });
      }
      emitter.emit("funded", { orderId });
    },

    /**
     * Capture + settle to EURC (floored), then hand the host a mock payout.
     * A floor miss lands the order in settlement_pending, not released — the
     * currency guarantee is not yet met, and saying otherwise would be a lie.
     */
    async release(orderId: string, proof: ReleaseProof): Promise<void> {
      const order = await get(orderId);
      const paymentInfo = paymentInfoFromRecord(order);
      const hash = getPaymentInfoHash(paymentInfo, config.chainId, config.escrowAddress);
      const priceOutMinor = BigInt(order.price_eur);

      const outcome = await runRelease(
        { escrow: deps.escrow, fx: deps.fx, settlementAddress: config.settlementAddress, tokenIn, tokenOut },
        {
          paymentInfo,
          amountMinor: BigInt(order.max_amount),
          priceOutMinor,
          wedge: order.wedge,
          proof,
          currentState: order.state,
          // Capture with exactly the fee the payer authorized. `release` swaps
          // the post-fee remainder, which is what the receiver actually holds.
          feeBps: paymentInfo.minFeeBps,
          feeReceiver: paymentInfo.feeReceiver,
        },
      );

      if (outcome.captureTxHash) {
        await deps.store.recordPaymentIdempotent({
          orderId, nonce: `${hash}:capture`, kind: "capture",
          status: "confirmed", txHash: outcome.captureTxHash, chain: "Arc_Testnet", amountMinor: BigInt(order.max_amount),
        });
      }

      if (outcome.status === "released") {
        if (outcome.swapTxHash) {
          await deps.store.recordPaymentIdempotent({
            orderId, nonce: `${hash}:swap`, kind: "swap",
            status: "confirmed", txHash: outcome.swapTxHash, chain: "Arc_Testnet", amountMinor: outcome.eurcOutMinor,
          });
        }

        // Return the surplus to the payer, when a rebate payer is wired and there
        // is a surplus. Do this BEFORE the payout so the seller's instruction
        // reflects what they actually retain — the floor, not floor + rebate.
        let rebateTxHash: string | undefined;
        if (deps.payRebate && outcome.rebateMinor > 0n) {
          const r = await deps.payRebate({
            orderId, to: order.payer as Address, amountMinor: outcome.rebateMinor,
          });
          rebateTxHash = r.txHash;
          await deps.store.recordPaymentIdempotent({
            orderId, nonce: `${hash}:rebate`, kind: "rebate",
            status: "confirmed", txHash: r.txHash, chain: "Arc_Testnet", amountMinor: outcome.rebateMinor,
          });
        }

        await deps.store.transition(orderId, "released", {
          eurcOutMinor: outcome.eurcOutMinor, rebateMinor: outcome.rebateMinor, settledAt: new Date(),
        });

        // What the seller keeps: the full settlement when no rebate was delivered,
        // or the floor once the surplus went back to the payer.
        const sellerEurcMinor = rebateTxHash ? outcome.eurcOutMinor - outcome.rebateMinor : outcome.eurcOutMinor;
        const payout = mockPayout({
          orderId, beneficiary: order.receiver as Address,
          eurcMinor: sellerEurcMinor, settlementTxHash: outcome.swapTxHash, now: now(),
        });
        // Persisted before the event fires: a handler that reads `payoutFor`
        // must not race the write that makes the answer exist.
        await deps.store.savePayout(orderId, payout);
        emitter.emit("released", {
          orderId, eurcOutMinor: outcome.eurcOutMinor, rebateMinor: outcome.rebateMinor, rebateTxHash,
        });
      } else {
        // Captured but not settled — funds are with the receiver as USDC.
        await deps.store.transition(orderId, "settlement_pending");
      }
    },

    /** Return the payer's money and bridge it back to receivingChain (invariant 5). */
    async refund(orderId: string): Promise<void> {
      let order = await get(orderId);
      const paymentInfo = paymentInfoFromRecord(order);
      // Capture the pre-transition state: it decides void vs refund AND is what
      // runRefund's guard validates (funded/released → refund_pending). Passing
      // the already-moved "refund_pending" would fail that guard against itself.
      const fromState = order.state;
      const mechanism = isCaptured(fromState) ? "refund" : "void";

      order = await deps.store.transition(orderId, "refund_pending");
      emitter.emit("refund_pending", { orderId });

      const bridgeBack = deps.refundBridgeParams?.(order);
      const outcome = await runRefund(
        { escrow: deps.escrow, bridge: deps.bridge },
        {
          paymentInfo,
          amountMinor: BigInt(order.max_amount),
          currentState: fromState,
          mechanism,
          refundCollector: config.refundCollector,
          ...(bridgeBack ? { bridgeBack } : {}),
        },
      );

      if (outcome.status === "refunded") {
        await deps.store.transition(orderId, "refunded");
        emitter.emit("refunded", { orderId, chain: order.receiving_chain });
      }
      // refund_pending is left as-is: the payer holds funds on Arc, origin-chain
      // leg still pending — recoverable by the reconciliation sweep.
    },

    async status(orderId: string): Promise<Order> {
      return toOrder(await get(orderId));
    },
  };
}

export type RivoKit = ReturnType<typeof createRivoKit>;
