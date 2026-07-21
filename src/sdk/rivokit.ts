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
}) => Promise<{ fundingTxHash?: string; authorizeTxHash: string }>;

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
};

export type RivoKitDeps = {
  store: OrderStore;
  escrow: Escrow;
  fx: SettlementFx;
  bridge: Bridge;
  fund: FundExecutor;
  config: RivoKitConfig;
  compliance?: ComplianceGate;
  emitter?: Emitter;
  /** Injected for determinism in tests. */
  now?: () => number;
  salt?: () => bigint;
  /** Arc→receivingChain bridge params for a refund; omit when refund stays on Arc. */
  refundBridgeParams?: (order: OrderRecord) => BridgeParams | undefined;
};

const DEFAULT_BUFFER_BPS = 150;

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
function toPaymentInfo(r: OrderRecord): PaymentInfo {
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

  /** Last payout instruction produced per order — the host reads this on `released`. */
  const payouts = new Map<string, PayoutInstruction>();

  async function get(orderId: string): Promise<OrderRecord> {
    const r = await deps.store.get(orderId);
    if (!r) throw new Error(`RivoKit: order ${orderId} tidak ada`);
    return r;
  }

  return {
    on: emitter.on,
    off: emitter.off,

    /** Read the mock payout instruction emitted for a settled order, if any. */
    payoutFor: (orderId: string): PayoutInstruction | undefined => payouts.get(orderId),

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
      if (deps.compliance) {
        const chain = config.screeningChain ?? "ARC-TESTNET";
        await deps.compliance.assertAllowed(params.payer, chain, "funding");
        await deps.compliance.assertAllowed(params.receiver, chain, "payout");
      }

      const bufferBps = params.bufferBps ?? config.bufferBps ?? DEFAULT_BUFFER_BPS;
      // Invert the settlement quote to find how much USDC clears priceEUR + buffer.
      const { amountInMinor: usdcAmount } = await deps.fx.lockQuote({
        address: params.payer,
        tokenIn,
        tokenOut,
        priceOutMinor: params.priceEURMinor,
        bufferBps,
        probeInMinor: params.priceEURMinor, // ~1:1 stablecoins; a probe near value
      });

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
        minFeeBps: 0,
        maxFeeBps: 0,
        feeReceiver: ZERO_ADDRESS,
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

    /** Move USDC to Arc and authorize into escrow. Emits funding_pending → funded. */
    async fund(orderId: string): Promise<void> {
      let order = await get(orderId);
      const paymentInfo = toPaymentInfo(order);
      const hash = getPaymentInfoHash(paymentInfo, config.chainId, config.escrowAddress);

      if (order.state === "created") {
        order = await deps.store.transition(orderId, "funding_pending");
        emitter.emit("funding_pending", { orderId });
      }

      const res = await deps.fund({ order, paymentInfo, hash });
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
      const paymentInfo = toPaymentInfo(order);
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
        await deps.store.transition(orderId, "released", {
          eurcOutMinor: outcome.eurcOutMinor, rebateMinor: outcome.rebateMinor, settledAt: new Date(),
        });
        const payout = mockPayout({
          orderId, beneficiary: order.receiver as Address,
          eurcMinor: outcome.eurcOutMinor, settlementTxHash: outcome.swapTxHash, now: now(),
        });
        payouts.set(orderId, payout);
        emitter.emit("released", { orderId, eurcOutMinor: outcome.eurcOutMinor, rebateMinor: outcome.rebateMinor });
      } else {
        // Captured but not settled — funds are with the receiver as USDC.
        await deps.store.transition(orderId, "settlement_pending");
      }
    },

    /** Return the payer's money and bridge it back to receivingChain (invariant 5). */
    async refund(orderId: string): Promise<void> {
      let order = await get(orderId);
      const paymentInfo = toPaymentInfo(order);
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
