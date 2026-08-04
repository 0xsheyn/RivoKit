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
import {
  release as runRelease,
  captureForPayout,
  retrySettlement as runRetrySettlement,
} from "../orchestrator/release.ts";
import { refund as runRefund } from "../orchestrator/refund.ts";
import type { Bridge, BridgeParams } from "../funding/bridge.ts";
import { createEmitter, type Emitter } from "../events/emitter.ts";
import type { ComplianceGate } from "../events/compliance.ts";
import { mockPayout } from "../payout/mock-payout.ts";
import { livePayout, type PayoutInstruction } from "../payout/instruction.ts";
import {
  toDestinationMinor,
  type PayoutLimits,
  type PayoutRail,
  type PayoutTarget,
} from "../payout/rail.ts";
import { assertFeeBps, grossUpForFee, netOfFee, InvalidFeeError } from "./fee.ts";

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
  payoutTo: PayoutTarget;
  wedge: Wedge;
  state: OrderState;
  /**
   * Why the order stopped where it did, when something refused it.
   *
   * Set on `settlement_pending` and `failed` — the two states a caller has to
   * make a decision about. It was stored from the beginning and simply never
   * surfaced, which left `settlement_pending` as a state the SDK could report
   * but not explain: "captured, not converted" with no way to learn whether the
   * floor was missed, the corridor refused the size, or a quote went stale.
   */
  failureReason: string | null;
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
  /**
   * Where the seller's money ends up. Defaults to "wallet" — the original
   * behaviour, where `release()` settles to EURC on Arc and stops.
   *
   * "bank" needs `deps.payoutRail`, and is checked against that rail's live
   * corridor limits HERE rather than at release: a payout the rail would refuse
   * must fail while nothing has moved, not after the escrow has been captured
   * and the funds are already out.
   */
  payoutTo?: PayoutTarget;
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
}) => Promise<{
  fundingTxHash?: string;
  /**
   * The authorize transaction, when this call produced one.
   *
   * OPTIONAL, and that is the honest shape. Executors are expected to be
   * idempotent — the reference one returns early when the escrow has already
   * collected — and in that case there is no new transaction to name. Returning
   * a placeholder instead would put a string that cannot be opened on a block
   * explorer into a ledger row marked `confirmed`.
   */
  authorizeTxHash?: string;
}>;

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
  /**
   * Which token the surplus is denominated in. EURC on the wallet path, where
   * the surplus is what the swap yielded above the floor; USDC on the bank
   * path, where no swap runs and the surplus is the captured amount the payout
   * quote did not need. Defaulted to the settlement token for callers written
   * before the bank path existed — but a host wiring `payoutTo: "bank"` must
   * read it, or it will send the wrong asset.
   */
  token: FxToken;
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
  /**
   * The fiat off-ramp, for orders created with `payoutTo: "bank"`.
   *
   * Injected because every off-ramp needs a payout API key, the funds owner's
   * signer, and the beneficiary's PII — three things RivoKit must not hold
   * (CLAUDE.md §5, §6). Omit it and `payoutTo: "bank"` is refused at
   * `createOrder`, which keeps the default build free of any payout capability
   * rather than half-wired.
   */
  payoutRail?: PayoutRail | undefined;
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

/**
 * A bank-bound order was refused before anything moved.
 *
 * Every case this covers is knowable at checkout: no rail is wired, or the
 * amount falls outside what the corridor accepts. Discovering either one after
 * capture would leave the order in `settlement_pending` holding USDC that the
 * off-ramp will never take — recoverable, but only by hand.
 */
export class PayoutUnavailableError extends Error {
  readonly code = "PAYOUT_UNAVAILABLE";
  readonly limits: PayoutLimits | null;

  constructor(message: string, limits: PayoutLimits | null = null) {
    super(message);
    this.name = "PayoutUnavailableError";
    this.limits = limits;
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
    // Rows written before the bank path existed have no column at all; they
    // were all wallet orders, so that is what they report.
    payoutTo: r.payout_to ?? "wallet",
    wedge: r.wedge,
    state: r.state,
    failureReason: r.failure_reason,
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

  /** The wired rail, or a clear refusal naming what is missing. */
  function requireRail(context: string): PayoutRail {
    const rail = deps.payoutRail;
    if (!rail) {
      throw new PayoutUnavailableError(
        `${context} requires deps.payoutRail, which is not wired. ` +
          'Inject a PayoutRail (see createCpnPayoutRail) or use payoutTo: "wallet".',
      );
    }
    return rail;
  }

  /**
   * Size a bank-bound order from the payout rail, then check it can be paid.
   *
   * Returns the NET the escrow must hand the settlement wallet: what the rail
   * says the floor costs today, plus the buffer that absorbs the drift between
   * now and release. Falls back to the FX quote for a rail that cannot
   * estimate — the buffer then has to cover a spread it was not measured
   * against, which is why `estimate` is worth implementing.
   */
  async function sizeForPayout(priceOutMinor: bigint, bufferBps: number): Promise<bigint> {
    const rail = requireRail('payoutTo: "bank"');
    const limits = await rail.limits();

    let net: bigint;
    if (rail.estimate) {
      const destinationMinor = toDestinationMinor(priceOutMinor, limits.destinationScale);
      const { requiredSourceMinor } = await rail.estimate(destinationMinor);
      net = requiredSourceMinor + (requiredSourceMinor * BigInt(bufferBps)) / 10_000n;
    } else {
      const q = await deps.fx.lockQuote({
        address: config.settlementAddress, tokenIn, tokenOut,
        priceOutMinor, bufferBps, probeInMinor: priceOutMinor,
      });
      net = q.amountInMinor;
    }

    assertWithinCorridor(net, rail, limits);
    return net;
  }

  /**
   * Refuse a bank-bound order the off-ramp could not actually pay out.
   *
   * The limits come from the rail, live, rather than from a constant here.
   * CPN enforces its minimum against the DESTINATION side, so the USDC figure
   * that clears moves with FX — 11 USDC to EUR/SEPA is refused while 12 is
   * accepted (CLAUDE.md). Anything hardcoded in this repo would be wrong within
   * a week and wrong silently.
   */
  function assertWithinCorridor(netSourceMinor: bigint, rail: PayoutRail, limits: PayoutLimits): void {
    if (netSourceMinor < limits.minSourceMinor) {
      throw new PayoutUnavailableError(
        `Order nets ${netSourceMinor} ${limits.sourceCurrency} but the ${rail.corridor} corridor ` +
          `takes at least ${limits.minSourceMinor}. Too small to reach a bank — settle to a wallet instead.`,
        limits,
      );
    }
    if (netSourceMinor > limits.maxSourceMinor) {
      throw new PayoutUnavailableError(
        `Order nets ${netSourceMinor} ${limits.sourceCurrency}, above the ${rail.corridor} corridor ` +
          `ceiling of ${limits.maxSourceMinor}.`,
        limits,
      );
    }
  }

  async function get(orderId: string): Promise<OrderRecord> {
    const r = await deps.store.get(orderId);
    if (!r) throw new Error(`RivoKit: no such order ${orderId}`);
    return r;
  }

  /**
   * Capture, then off-ramp — the bank-bound half of `release`.
   *
   * THE ORDER OF OPERATIONS IS THE DESIGN
   *
   * A payout quote lives 30-60 seconds and the capture has already happened by
   * the time one is asked for, so every avoidable delay between quoting and
   * broadcasting is a real risk of PAYMENT_EXPIRED on money that is already out
   * of escrow. That is why `ready()` runs first (allowance approvals are
   * transactions), why the floor check is two integer comparisons, and why the
   * rebate — the one remaining optional step — is deliberately moved to AFTER
   * the broadcast. On the wallet path the rebate goes first, because there the
   * swap has already fixed everything and nothing is racing a clock. Here the
   * priority is inverted: get the irreversible step done while the quote is
   * alive, then tidy up.
   *
   * FAILING SAFE
   *
   * Every refusal before `submit` lands the order in `settlement_pending` with
   * a stated reason. That state is exactly true of this situation: captured,
   * holding USDC, not yet in the promised currency. The funds sit in the
   * settlement wallet and the payout can be retried without touching the
   * escrow again.
   */
  async function releaseToBank(args: {
    order: OrderRecord;
    paymentInfo: PaymentInfo;
    hash: Hex;
    priceOutMinor: bigint;
    proof: ReleaseProof;
  }): Promise<void> {
    const { order, paymentInfo, hash, priceOutMinor, proof } = args;
    const orderId = order.id;
    // Not reachable through `createOrder`, which refuses a bank order without a
    // rail — but a record can outlive the wiring that created it, and losing
    // the rail between create and release must not capture funds that then have
    // nowhere to go. Hence the check before the capture, not after.
    const rail = requireRail(`Order ${orderId} is bank-bound and`);

    // Read the corridor BEFORE capturing. It is the last thing that can fail
    // harmlessly, and it decides the scale the floor has to be converted into.
    const limits = await rail.limits();
    const destinationMinor = toDestinationMinor(priceOutMinor, limits.destinationScale);

    const cap = await captureForPayout(
      { escrow: deps.escrow },
      {
        paymentInfo,
        amountMinor: BigInt(order.max_amount),
        wedge: order.wedge,
        proof,
        currentState: order.state,
        feeBps: paymentInfo.minFeeBps,
        feeReceiver: paymentInfo.feeReceiver,
      },
    );

    if (cap.captureTxHash) {
      await deps.store.recordPaymentIdempotent({
        orderId, nonce: `${hash}:capture`, kind: "capture",
        status: "confirmed", txHash: cap.captureTxHash, chain: "Arc_Testnet",
        amountMinor: BigInt(order.max_amount),
      });
    }

    await payoutAfterCapture({ order, hash, netMinor: cap.netMinor, destinationMinor, rail, limits });
  }

  /**
   * The bookkeeping a wallet-path release owes once the swap has landed: the
   * swap row, the rebate, the transition, the MOCK payout instruction, the
   * event.
   *
   * Shared by `release()` and `retrySettlement()` so the two cannot drift.
   * A retry reaches `released` by a different road, but what is owed at the end
   * of it is identical — and a second copy of this is a second place for the
   * rebate token or the payout-before-event ordering to go wrong.
   */
  async function settleWalletRelease(args: {
    order: OrderRecord;
    hash: Hex;
    outcome: { eurcOutMinor: bigint; rebateMinor: bigint; swapTxHash?: string | undefined };
  }): Promise<void> {
    const { order, hash, outcome } = args;
    const orderId = order.id;

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
        orderId, to: order.payer as Address, amountMinor: outcome.rebateMinor, token: tokenOut,
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
  }

  /**
   * Everything on the bank path AFTER the escrow has been emptied: quote, floor
   * check, broadcast, ledger, rebate.
   *
   * Split out of `releaseToBank` because it has to be re-enterable. Every
   * refusal below leaves the order in `settlement_pending` holding captured
   * USDC, and that state is explicitly recoverable — but the only way back in
   * used to be `release()`, which starts by capturing an escrow that is already
   * empty. `retrySettlement()` enters here instead.
   *
   * Takes the rail and its limits from the caller rather than reading them: on
   * the first pass they were deliberately read BEFORE the capture, as the last
   * thing that could still fail harmlessly.
   */
  async function payoutAfterCapture(args: {
    order: OrderRecord;
    hash: Hex;
    netMinor: bigint;
    destinationMinor: bigint;
    rail: PayoutRail;
    limits: PayoutLimits;
  }): Promise<void> {
    const { order, hash, netMinor, destinationMinor, rail, limits } = args;
    const orderId = order.id;
    const cap = { netMinor };

    /**
     * Captured, but the fiat leg did not start. Funds are safe; say why.
     *
     * A RETRY that stalls again is already in `settlement_pending`, and the
     * lifecycle has no self-loops — deliberately, and it is tested. So the
     * second refusal is recorded as an event rather than a transition: the
     * state is already correct, only the reason is new. Transitioning would
     * throw `InvalidStateTransition` and turn a recoverable stall into an
     * exception the caller has to distinguish from a real failure.
     */
    const stall = async (reason: string): Promise<void> => {
      if (order.state === "settlement_pending") {
        await deps.store.recordEvent({ orderId, type: "payout.stalled", payload: { reason } });
        return;
      }
      await deps.store.transition(orderId, "settlement_pending", { failureReason: reason });
    };

    if (cap.netMinor < limits.minSourceMinor) {
      await stall(
        `Captured ${cap.netMinor} ${limits.sourceCurrency}, below the ${rail.corridor} minimum of ${limits.minSourceMinor}.`,
      );
      return;
    }

    await rail.ready?.(cap.netMinor);

    let quote;
    try {
      quote = await rail.quote({ orderId, destinationMinor, availableSourceMinor: cap.netMinor });
    } catch (e) {
      await stall(`Payout quote failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      return;
    }

    // The floor, checked here and not inside the rail. A host-supplied rail
    // does not get to decide whether the seller was paid enough.
    if (quote.destinationMinor < destinationMinor) {
      await stall(
        `Payout quote delivers ${quote.destinationMinor} ${quote.destinationCurrency}, below the floor of ${destinationMinor}.`,
      );
      return;
    }
    if (quote.requiredSourceMinor > cap.netMinor) {
      await stall(
        `Payout needs ${quote.requiredSourceMinor} ${limits.sourceCurrency} to clear the floor but only ` +
          `${cap.netMinor} was captured. Nothing was broadcast.`,
      );
      return;
    }
    if (now() >= quote.expiresAt) {
      await stall(`Payout quote expired at ${quote.expiresAt} before it could be broadcast.`);
      return;
    }

    // ── Past this line the payout is irreversible. ──────────────────────
    const submission = await rail.submit(quote);

    // Persisted before the transition, not after: `offramp_states_have_live_payout`
    // refuses `payout_pending` on an order with no live payout record, and that
    // constraint is what stops an order from claiming an irreversible action
    // with no evidence it happened.
    await deps.store.savePayout(
      orderId,
      livePayout({
        orderId,
        beneficiary: order.receiver as Address,
        rail: rail.id,
        corridor: rail.corridor,
        paymentId: submission.paymentId,
        status: submission.status,
        source: {
          currency: limits.sourceCurrency,
          chain: "Arc_Testnet",
          amountMinor: submission.requiredSourceMinor,
          txHash: submission.txHash,
        },
        target: {
          currency: submission.destinationCurrency,
          amountMinor: submission.destinationMinor,
          scale: submission.destinationScale,
        },
        now: now(),
      }),
    );

    await deps.store.recordPaymentIdempotent({
      orderId, nonce: `${hash}:payout`, kind: "payout",
      status: "pending", chain: "Arc_Testnet", amountMinor: submission.requiredSourceMinor,
      ...(submission.txHash ? { txHash: submission.txHash } : {}),
    });

    await deps.store.transition(orderId, "payout_pending");

    // The surplus: what the payer overpaid as buffer and the quote did not
    // need. USDC here, not EURC — no swap ran — so the token travels with the
    // amount or a host would send the wrong asset.
    let rebateTxHash: string | undefined;
    const rebateMinor = cap.netMinor - submission.requiredSourceMinor;
    if (deps.payRebate && rebateMinor > 0n) {
      const r = await deps.payRebate({
        orderId, to: order.payer as Address, amountMinor: rebateMinor, token: tokenIn,
      });
      rebateTxHash = r.txHash;
      await deps.store.recordPaymentIdempotent({
        orderId, nonce: `${hash}:rebate`, kind: "rebate",
        status: "confirmed", txHash: r.txHash, chain: "Arc_Testnet", amountMinor: rebateMinor,
      });
    }

    emitter.emit("payout_pending", {
      orderId,
      paymentId: submission.paymentId,
      rail: rail.id,
      corridor: rail.corridor,
      sourceMinor: submission.requiredSourceMinor,
      destinationMinor: submission.destinationMinor,
      destinationCurrency: submission.destinationCurrency,
      rebateMinor,
      rebateTxHash,
    });
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

    /**
     * Ask the rail where a broadcast payout has got to, and advance the order
     * if it has finished.
     *
     * The FALLBACK path, not the source of truth. Webhooks are what should
     * drive a payout to its terminal state; this exists for hosts and scripts
     * with no public endpoint, and it writes only what the rail reports. It
     * cannot invent progress: a non-terminal status updates the stored
     * reference and leaves the order in `payout_pending`.
     *
     * A FAILED payout returns the order to `settlement_pending` rather than
     * `failed`, because that is what is actually true — CPN sends the USDC back
     * to the refund address, which is the settlement wallet, so the order is
     * once again captured-but-not-converted and the payout can be retried.
     */
    async refreshPayout(orderId: string): Promise<PayoutInstruction | null> {
      const order = await get(orderId);
      const payout = await deps.store.getPayout(orderId);
      if (!payout?.reference) return payout;
      // `paid_out` is included deliberately. The order is finished, but its
      // ledger row may not be: the row is written `pending` at broadcast and
      // settled on a later read, so a run that ended before the hash existed
      // leaves a gap. Excluding terminal orders would make that gap permanent —
      // the one state that can never self-heal.
      if (order.state !== "payout_pending" && order.state !== "paid_out") return payout;

      const rail = deps.payoutRail;
      if (!rail?.status) return payout;

      const observed = await rail.status(payout.reference.paymentId);
      // Nothing to learn: the status is unchanged AND we already hold every
      // artefact this read could add. The fiat reference is part of that test
      // and not an afterthought — it can appear on a read AFTER the hash, so
      // testing the hash alone would return early and lose it permanently.
      // Phrased as "the rail offered none" rather than "we hold one" because
      // rails that carry `refCode` in the memo never issue a reference at all,
      // and demanding one would make every later read do pointless work.
      const holdsFiatRef =
        payout.reference.fiatNetworkPaymentRef != null || observed.fiatNetworkPaymentRef == null;
      const settled =
        observed.status === payout.reference.status && payout.reference.txHash != null && holdsFiatRef;
      if (settled || (observed.status === payout.reference.status && !observed.terminal && holdsFiatRef)) {
        return payout;
      }

      // The on-chain hash only exists once the transfer is mined, so it arrives
      // here rather than at broadcast. Never overwrite a hash we already hold
      // with an absent one — a later read that omits it is silence, not news.
      // The same rule applies to the fiat reference.
      const txHash = observed.txHash ?? payout.reference.txHash;
      const fiatRef = observed.fiatNetworkPaymentRef ?? payout.reference.fiatNetworkPaymentRef;
      const updated: PayoutInstruction = {
        ...payout,
        source: { ...payout.source, settlementTxHash: txHash },
        reference: {
          ...payout.reference,
          status: observed.status,
          txHash,
          ...(fiatRef ? { fiatNetworkPaymentRef: fiatRef } : {}),
        },
      };
      await deps.store.savePayout(orderId, updated);

      // Settle the ledger row too. It was written `pending` at submit time
      // because that was the truth then; leaving it there once the payout is
      // terminal would make the ledger disagree with the order it describes.
      const nonce = `${getPaymentInfoHash(
        paymentInfoFromRecord(order), config.chainId, config.escrowAddress,
      )}:payout`;
      if (observed.delivered && txHash) {
        await deps.store.advancePayment(nonce, { status: "confirmed", txHash });
      } else if (observed.terminal && !observed.delivered) {
        await deps.store.advancePayment(nonce, {
          status: "failed",
          errorReason: observed.failureReason ?? `${payout.reference.rail} reported ${observed.status}`,
        });
      }

      // Only move an order that is still in flight. Re-running this against an
      // order already at `paid_out` settles its ledger row and stops there —
      // `paid_out → paid_out` is not a legal transition, and re-emitting a
      // terminal event would tell a host something happened twice.
      if (order.state !== "payout_pending") return updated;

      if (observed.delivered) {
        await deps.store.transition(orderId, "paid_out", { settledAt: new Date() });
        emitter.emit("paid_out", {
          orderId,
          paymentId: payout.reference.paymentId,
          destinationMinor: payout.target.amountMinor,
          destinationCurrency: payout.target.currency,
        });
      } else if (observed.terminal) {
        await deps.store.transition(orderId, "settlement_pending", {
          failureReason:
            `Payout ${payout.reference.paymentId} failed on ${payout.reference.rail}` +
            `${observed.failureReason ? `: ${observed.failureReason}` : ""}. ` +
            "Funds return to the settlement wallet as the source token.",
        });
      }
      return updated;
    },

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

      // How much USDC clears priceEUR + buffer.
      //
      // Which market to ask depends on where the money is going. A wallet order
      // is sized by inverting the settlement swap, because that swap is what
      // has to clear the floor. A bank order is sized from the PAYOUT rail:
      // the swap never runs, and pricing the buffer against StableFX's spread
      // when CPN's is what the order will actually pay is sizing against the
      // wrong market — the kind of mismatch that shows up as a stalled payout
      // after the escrow has already been captured.
      const payoutTo = params.payoutTo ?? "wallet";
      let netUsdcAmount: bigint;
      if (payoutTo === "bank") {
        netUsdcAmount = await sizeForPayout(params.priceEURMinor, bufferBps);
      } else {
        ({ amountInMinor: netUsdcAmount } = await deps.fx.lockQuote({
          address: params.payer,
          tokenIn,
          tokenOut,
          priceOutMinor: params.priceEURMinor,
          bufferBps,
          probeInMinor: params.priceEURMinor, // ~1:1 stablecoins; a probe near value
        }));
      }

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
        payoutTo,
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

      // An executor that found the escrow already collected has no NEW hash to
      // report, and must not invent one: `confirmed_has_tx` only asks that a
      // hash is present, so a placeholder would satisfy the constraint while
      // putting an unopenable string in a ledger whose whole discipline is that
      // a confirmed row can be checked against the chain. No hash, no row —
      // and the row from the original authorize is already there anyway.
      if (res.authorizeTxHash) {
        await deps.store.recordPaymentIdempotent({
          orderId, nonce: `${hash}:authorize`, kind: "authorize",
          status: "confirmed", txHash: res.authorizeTxHash, chain: "Arc_Testnet", amountMinor: paymentInfo.maxAmount,
        });
      }

      order = await get(orderId);
      // The emit belongs INSIDE the transition, and used to sit outside it —
      // the only one of the seven emits in this file that did.
      //
      // Funding executors are idempotent by design (the reference one returns
      // early when the escrow has already collected), so a repeated `fund()`
      // does not throw. It simply fell through to the emit, and `funded` fired
      // again on an order that was already funded — or, worse, on one that had
      // since been refunded. A host that ships goods or grants access on
      // `funded` would have done it twice.
      //
      // A state other than `funding_pending` here means the order did not
      // become funded on THIS call, so nothing is announced. Note that leaves
      // `failed → funded` unhandled: it is a legal transition the state machine
      // allows for floor-miss recovery, but nothing drives it from here, and
      // wiring it in silently would change recovery semantics rather than fix
      // the defect this comment is about.
      if (order.state === "funding_pending") {
        await deps.store.transition(orderId, "funded", { fundedAt: new Date() });
        emitter.emit("funded", { orderId });
      }
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

      // Bank-bound orders take a different road entirely: no swap, and the
      // fiat rate is locked by the off-ramp's quote instead of the swap's
      // stopLimit. Branching here rather than inside `runRelease` keeps the two
      // state machines apart — this path ends in `payout_pending`, that one in
      // `released`, and nothing should be able to confuse them.
      if ((order.payout_to ?? "wallet") === "bank") {
        await releaseToBank({ order, paymentInfo, hash, priceOutMinor, proof });
        return;
      }

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
        await settleWalletRelease({ order, hash, outcome });
      } else {
        // Captured but not settled — funds are with the receiver as USDC. The
        // reason travels with the transition: `settlement_pending` with no
        // stated cause is the hardest state in the lifecycle to act on.
        await deps.store.transition(orderId, "settlement_pending", { failureReason: outcome.reason });
      }
    },

    /**
     * Finish a wallet-path settlement that was captured but never converted.
     *
     * `settlement_pending` has always been documented as recoverable — the
     * escrow is empty, the USDC sits with the receiver, and only the swap is
     * missing. But until now the only public way back in was `release()`, which
     * begins by capturing an escrow that has nothing left to capture. The
     * recovery existed (`retrySettlement` in the orchestrator, proven by
     * `scripts/live-recovery.mjs`) and was simply not reachable without a deep
     * import into unsupported internals.
     *
     * Bank-bound orders come here too, and take the other road: no swap, just
     * the payout leg again, against a fresh quote. Either way the escrow is
     * never touched a second time.
     *
     * Idempotent in the direction that matters — a retry that fails again
     * leaves the order exactly where it was, with a new reason recorded.
     */
    async retrySettlement(orderId: string): Promise<void> {
      const order = await get(orderId);
      if (order.state !== "settlement_pending") {
        throw new Error(
          `Order ${orderId} is ${order.state}, not settlement_pending. ` +
            "retrySettlement only resumes a capture that never reached its currency; " +
            "use release() to start one.",
        );
      }

      const paymentInfo = paymentInfoFromRecord(order);
      const hash = getPaymentInfoHash(paymentInfo, config.chainId, config.escrowAddress);
      const priceOutMinor = BigInt(order.price_eur);
      // What the settlement wallet actually holds: the escrow split the operator
      // fee off at capture, so the gross was never there to convert.
      const netMinor = netOfFee(BigInt(order.max_amount), paymentInfo.minFeeBps);

      if ((order.payout_to ?? "wallet") === "bank") {
        const rail = requireRail(`Order ${orderId} is bank-bound and`);
        const limits = await rail.limits();
        await payoutAfterCapture({
          order,
          hash,
          netMinor,
          destinationMinor: toDestinationMinor(priceOutMinor, limits.destinationScale),
          rail,
          limits,
        });
        return;
      }

      const outcome = await runRetrySettlement(
        { escrow: deps.escrow, fx: deps.fx, settlementAddress: config.settlementAddress, tokenIn, tokenOut },
        { amountMinor: netMinor, priceOutMinor },
      );

      if (outcome.status === "released") {
        await settleWalletRelease({ order, hash, outcome });
        return;
      }

      // Still short. No transition — the lifecycle has no self-loops — so the
      // fresh reason is recorded as an event instead.
      await deps.store.recordEvent({
        orderId, type: "settlement.stalled", payload: { reason: outcome.reason },
      });
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
