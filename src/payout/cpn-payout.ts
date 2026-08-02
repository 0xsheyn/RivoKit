/**
 * CPN as a `PayoutRail` — the executing off-ramp behind `release()`.
 *
 * WHY THIS QUOTES THE DESTINATION SIDE
 *
 * Every cash-out proven so far fixed the SOURCE amount: "send 15 USDC, see what
 * arrives". That is the wrong direction for a settlement product. RivoKit
 * guarantees the seller a floor in fiat, so the amount that must be pinned is
 * the one the seller receives — CPN then tells us how much USDC that costs, and
 * whatever the capture holds beyond it is the payer's surplus rather than a
 * windfall for the seller. Fixing the source instead would make the delivered
 * euro a function of the rate at broadcast time, which is precisely the
 * exposure the floor exists to remove.
 *
 * WHAT IS INJECTED AND WHY
 *
 * Three things, each because it is a credential or a secret that belongs to the
 * host (CLAUDE.md §5, §6):
 *
 *   `ramp`      carries the CPN API key. Server-only, never a browser bundle.
 *   `signIntent` is the settlement wallet signing the Permit2 message. This
 *               module never sees a private key, so the wallet that HOLDS the
 *               USDC is the wallet that authorizes it to leave — the same split
 *               `submitSigned` was written for.
 *   `details`   is the beneficiary's PII (IBAN, travel-rule identity). It is
 *               encrypted to the quote's JWK before it leaves the process and
 *               is never persisted by RivoKit.
 *
 * THE ALLOWANCE IS PRE-WORK, NOT PART OF SUBMIT
 *
 * Permit2 must be approved before a broadcast or it fails, and an approval is a
 * transaction — seconds that a 30-60 second quote cannot spare. So it runs in
 * `ready()`, before any quote exists. By the time the clock starts, the only
 * remaining calls are prepare and submit.
 */
import type { Hex } from "viem";
import type { CpnQuote, CpnTransaction } from "../ramp/cpn-client.ts";
import type { CpnFieldValue } from "../ramp/cpn-encrypt.ts";
import type { CpnRamp } from "../ramp/cpn-ramp.ts";
import { isPaymentTerminal, type CpnPaymentState } from "../ramp/cpn-state.ts";
import { fromDecimalStringScaled, toDecimalStringScaled } from "../settlement-fx/units.ts";
import type {
  PayoutLimits,
  PayoutQuote,
  PayoutQuoteRequest,
  PayoutRail,
  PayoutStatus,
  PayoutSubmission,
} from "./rail.ts";

/** Everything CPN requires about the beneficiary, resolved per order. */
export type CpnPayoutDetails = {
  /** Array of {name, value}; ADDRESS values are objects. */
  travelRule: CpnFieldValue[];
  beneficiaryAccount: CpnFieldValue[];
  useCase: string;
  /** Enum PMT001..PMT030. */
  reasonForPayment: string;
};

export type CreateCpnPayoutRailParams = {
  ramp: CpnRamp;
  /** Corridor key for the record, e.g. "EUR-SEPA". */
  corridor: string;
  /** ISO-3166 alpha-2 of the destination, used to look the route limits up. */
  destinationCountry: string;
  /** Decimal places of the destination currency. 2 for EUR/USD. */
  destinationScale?: number;
  /**
   * The settlement wallet: it holds the captured USDC, signs the intent, and is
   * where CPN returns funds if the payment fails.
   */
  senderAddress: string;
  refundAddress?: string;
  /** Resolve the beneficiary for an order. Async: it usually reads a database. */
  details: (orderId: string) => Promise<CpnPayoutDetails> | CpnPayoutDetails;
  /** The settlement wallet signing the Permit2 message. No key reaches this module. */
  signIntent: (message: CpnTransaction["messageToBeSigned"]) => Promise<Hex>;
  /**
   * Ensure Permit2 may pull at least `amountMinor` USDC from `senderAddress`.
   * A no-op when the allowance already covers it. Omit only if the host
   * guarantees a standing allowance — without it a broadcast will fail.
   */
  ensureAllowance?: (amountMinor: bigint) => Promise<void>;
  /** Injected for determinism in tests. Unix seconds. */
  now?: () => number;
};

/** What `quote` stashes for `submit`; opaque to the orchestrator. */
type CpnIntent = {
  quote: CpnQuote;
  payment: { id: string; status?: string };
  transaction: CpnTransaction;
};

const SOURCE_SCALE = 6; // USDC

export function createCpnPayoutRail(params: CreateCpnPayoutRailParams): PayoutRail {
  const { ramp } = params;
  const destinationScale = params.destinationScale ?? 2;
  const refundAddress = params.refundAddress ?? params.senderAddress;
  const now = params.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    id: "cpn",
    corridor: params.corridor,

    /**
     * Route limits, read live. CPN enforces them against the destination side,
     * so the USDC figure that clears drifts with FX and cannot be a constant
     * here — 11 USDC to EUR/SEPA is refused while 12 is accepted (CLAUDE.md).
     */
    async limits(): Promise<PayoutLimits> {
      const route = await ramp.client.findRoute(
        { sourceCurrency: ramp.corridor.sourceCurrency, destinationCountry: params.destinationCountry },
        {
          destinationCurrency: ramp.corridor.destinationCurrency,
          paymentMethodType: ramp.corridor.paymentMethodType,
          blockchain: ramp.corridor.blockchain,
        },
      );
      if (!route) {
        throw new Error(
          `CPN has no ${ramp.corridor.destinationCurrency}/${ramp.corridor.paymentMethodType} route ` +
            `from ${ramp.corridor.sourceCurrency} on ${ramp.corridor.blockchain} to ${params.destinationCountry}. ` +
            "Check the corridor against `node scripts/probe-cpn-source.mjs`.",
        );
      }
      return {
        minSourceMinor: fromDecimalStringScaled(route.cryptoLimit.min, SOURCE_SCALE),
        maxSourceMinor: fromDecimalStringScaled(route.cryptoLimit.max, SOURCE_SCALE),
        sourceCurrency: route.cryptoLimit.currency,
        destinationCurrency: route.destinationCurrency,
        destinationScale,
      };
    },

    /**
     * Price the payout without creating one.
     *
     * A CPN quote is free to ask for and expires on its own if nothing funds
     * it, so sizing this way costs one API call and leaves no state behind. The
     * rate WILL have moved by the time `quote` runs at release — that is what
     * the order's buffer is for. The point is to size the buffer against CPN's
     * market rather than StableFX's.
     */
    async estimate(destinationMinor: bigint): Promise<{ requiredSourceMinor: bigint }> {
      const { quote } = await ramp.quote({
        destinationAmount: toDecimalStringScaled(destinationMinor, destinationScale),
      });
      return { requiredSourceMinor: fromDecimalStringScaled(quote.sourceAmount.amount, SOURCE_SCALE) };
    },

    /** Approve Permit2 up front so it cannot eat the quote's 30-60 second life. */
    async ready(availableSourceMinor: bigint): Promise<void> {
      await params.ensureAllowance?.(availableSourceMinor);
    },

    /**
     * Lock a rate that delivers exactly `destinationMinor`, then build the
     * payment and the unsigned intent. Nothing has been broadcast when this
     * returns — `prepare` creates the transaction but does not submit it.
     *
     * Preparing here rather than in `submit` is deliberate: encryption and two
     * API round-trips are the slow part, and doing them before the floor check
     * costs nothing if the check fails (an unfunded CPN payment simply expires)
     * while doing them after would spend the quote's remaining life on work
     * that could have run in parallel with the decision.
     */
    async quote(req: PayoutQuoteRequest): Promise<PayoutQuote> {
      const destinationAmount = toDecimalStringScaled(req.destinationMinor, destinationScale);
      const { quote } = await ramp.quote({ destinationAmount });

      const details = await params.details(req.orderId);
      const { payment, transaction } = await ramp.prepare({
        quote,
        travelRule: details.travelRule,
        beneficiaryAccount: details.beneficiaryAccount,
        senderAddress: params.senderAddress,
        refundAddress,
        useCase: details.useCase,
        reasonForPayment: details.reasonForPayment,
        customerRefId: req.orderId.slice(0, 64),
        // `customerRefId` is OURS — it never leaves Circle. `refCode` is the one
        // that crosses over: Circle puts it in the memo on the beneficiary's
        // bank statement, alongside the sender name from the travel rule
        // (cpn/concepts/payments/payment-reference). Since nothing on our side
        // can observe the fiat leg landing, this is what lets a real recipient
        // match a credit back to an order — so it must carry the order id, not
        // a decorative string.
        refCode: req.orderId.slice(0, 64),
      });

      const intent: CpnIntent = { quote, payment, transaction };
      return {
        requiredSourceMinor: fromDecimalStringScaled(quote.sourceAmount.amount, SOURCE_SCALE),
        destinationMinor: fromDecimalStringScaled(quote.destinationAmount.amount, destinationScale),
        destinationCurrency: quote.destinationAmount.currency,
        destinationScale,
        sourceCurrency: quote.sourceAmount.currency,
        expiresAt: Math.floor(new Date(quote.quoteExpireDate).getTime() / 1000),
        intent,
      };
    },

    /**
     * Sign and BROADCAST. Irreversible: past this the USDC has left the
     * settlement wallet and no operator refund can recall it.
     */
    async submit(q: PayoutQuote): Promise<PayoutSubmission> {
      const intent = q.intent as CpnIntent;
      if (!intent?.transaction || !intent.payment?.id) {
        throw new Error("createCpnPayoutRail.submit: quote.intent is not a prepared CPN payment");
      }
      // Re-check on the way in. The caller checks too, but this is the last
      // line before an irreversible call and the cost of checking twice is one
      // comparison.
      const t = now();
      if (t >= q.expiresAt) {
        throw new Error(
          `CPN quote ${intent.quote.id} expired at ${q.expiresAt} (now ${t}); refusing to broadcast.`,
        );
      }

      const signature = await params.signIntent(intent.transaction.messageToBeSigned);
      const submitted = await ramp.submitSigned(
        { paymentId: intent.payment.id, transaction: intent.transaction },
        signature,
      );

      return {
        paymentId: intent.payment.id,
        status: submitted.status,
        requiredSourceMinor: q.requiredSourceMinor,
        destinationMinor: q.destinationMinor,
        destinationCurrency: q.destinationCurrency,
        destinationScale,
        txHash: (submitted as { txHash?: string }).txHash,
      };
    },

    /**
     * Poll CPN for the payment's status.
     *
     * The fallback path, not the source of truth: webhooks drive the stored
     * record, and CLAUDE.md documents what happens when polling competes with
     * them. Provided so a script or a demo with no public endpoint can still
     * follow a payout to COMPLETED.
     */
    async status(paymentId: string): Promise<PayoutStatus> {
      const payment = await ramp.status(paymentId);
      const state = payment.status as CpnPaymentState;
      // The Arc hash lives here and nowhere else: `submitTransaction` returns
      // before the transfer is mined, so the hash cannot exist at broadcast
      // time. Reading it here is what lets the ledger row become `confirmed`
      // instead of sitting at `pending` forever.
      const onChain = payment.onChainTransactions?.find((t) => t?.transactionHash);
      return {
        status: payment.status,
        terminal: isPaymentTerminal(state),
        delivered: state === "COMPLETED",
        txHash: onChain?.transactionHash,
        // Captured because it is the only thing that crosses to the beneficiary
        // — and because the fiat leg is the one part of this flow nobody here
        // can observe. Without storing it, a real recipient asking "which
        // credit is this?" has nothing to match against.
        fiatNetworkPaymentRef: payment.fiatNetworkPaymentRef,
        failureReason: state === "FAILED" ? payment.failureReason : undefined,
      };
    },
  };
}

/**
 * The Permit2 amount baked into a prepared intent.
 *
 * Exposed because `ready()` cannot use it, and that trade-off should be visible
 * rather than buried. The exact permit amount only exists once the intent has
 * been prepared, which is after the quote clock has started — so `ready()`
 * approves the captured balance instead, an upper bound. The cost is a standing
 * allowance remainder: the broadcast consumes only what it needs, and the rest
 * stays approved to Permit2 until something revokes it.
 *
 * A host that would rather approve exactly (the demo's wallet cash-out was
 * proven that way, allowance returning to zero) can skip `ensureAllowance`,
 * read this off the prepared transaction, and approve between quote and submit
 * — accepting that an approval transaction now runs against the quote's 30-60
 * second life. `scripts/live-ramp-revoke.mjs` clears a leftover allowance.
 */
export function permitAmountOf(transaction: CpnTransaction): bigint {
  const permitted = (transaction.messageToBeSigned.message as Record<string, unknown> | undefined)
    ?.["permitted"] as { amount?: string | number } | undefined;
  return BigInt(permitted?.amount ?? 0);
}
