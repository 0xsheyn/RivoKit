/**
 * CPN off-ramp — the one object the host drives for USDC → local-fiat payout.
 *
 * This composes the CPN modules (client, encryption, signing, state) into a
 * small surface with a deliberate safe/gated split:
 *
 *   - `quote` and `prepare` never move money. `prepare` creates the payment and
 *     the onchain transaction (the Permit2 intent to sign) but does NOT submit.
 *   - `submit` is the irreversible step: it signs the intent and broadcasts.
 *     Once the transaction reaches BROADCASTED the sender's USDC is gone. So the
 *     signer is INJECTED, exactly like RivoKit's FundExecutor — who signs and
 *     how is the host's environment, and the broadcast is a decision the host
 *     makes explicitly, not a side effect of preparing.
 *
 * The corridor (sender/recipient type, countries, chain, currencies, method) is
 * fixed per ramp instance; amounts and beneficiary data vary per payment. Both
 * amount sides are supported — pass sourceAmount to fix what the payer sends, or
 * destinationAmount to fix what the beneficiary receives.
 */
import type { Account } from "viem";
import {
  createCpnClient,
  quoteSpreadBps,
  summarizeQuoteFees,
  type CpnAmount,
  type CpnClient,
  type CpnParty,
  type CpnPayment,
  type CpnQuote,
  type CpnTransaction,
} from "./cpn-client.ts";
import { encryptPaymentData, type CpnFieldValue } from "./cpn-encrypt.ts";
import { signPaymentIntent } from "./cpn-sign.ts";

export type RampCorridor = {
  senderType: CpnParty;
  recipientType: CpnParty;
  senderCountry: string;
  destinationCountry: string;
  blockchain: string;
  paymentMethodType: string;
  sourceCurrency: string;
  destinationCurrency: string;
};

export type RampQuote = {
  quote: CpnQuote;
  /** Total fee + by-type map. */
  fees: { total: CpnAmount; byType: Record<string, string> };
  /** FX margin in basis points (raw vs applied rate). */
  spreadBps: number;
};

export type PrepareParams = {
  quote: CpnQuote;
  /** Array of {name, value}; ADDRESS values are objects. */
  travelRule: CpnFieldValue[];
  beneficiaryAccount: CpnFieldValue[];
  senderAddress: string;
  refundAddress: string;
  useCase: string;
  /** Enum PMT001..PMT030. */
  reasonForPayment: string;
  customerRefId: string;
  refCode?: string;
};

export type CreateCpnRampParams = {
  apiKey: string;
  corridor: RampCorridor;
  /** Injectable for tests. */
  client?: CpnClient;
};

export function createCpnRamp(params: CreateCpnRampParams) {
  const cpn = params.client ?? createCpnClient({ apiKey: params.apiKey });
  const c = params.corridor;

  return {
    client: cpn,
    corridor: c,

    /** Lock a rate for this corridor. Fix exactly one amount side. */
    async quote(amount: { sourceAmount?: string; destinationAmount?: string }): Promise<RampQuote> {
      const quote = await cpn.createQuote({
        senderType: c.senderType,
        recipientType: c.recipientType,
        senderCountry: c.senderCountry,
        destinationCountry: c.destinationCountry,
        blockchain: c.blockchain,
        paymentMethodType: c.paymentMethodType,
        sourceCurrency: c.sourceCurrency,
        destinationCurrency: c.destinationCurrency,
        ...(amount.sourceAmount !== undefined ? { sourceAmount: amount.sourceAmount } : {}),
        ...(amount.destinationAmount !== undefined ? { destinationAmount: amount.destinationAmount } : {}),
      });
      return { quote, fees: summarizeQuoteFees(quote), spreadBps: quoteSpreadBps(quote) };
    },

    /**
     * Create the payment and the onchain transaction. Encrypts the PII to the
     * quote's key. Does NOT broadcast — the returned transaction carries the
     * `messageToBeSigned` for `submit`. Must run before the quote expires.
     */
    async prepare(p: PrepareParams): Promise<{ payment: CpnPayment; transaction: CpnTransaction }> {
      const enc = await encryptPaymentData(p.travelRule, p.beneficiaryAccount, p.quote.certificate.jwk);
      const payment = await cpn.createPayment({
        quoteId: p.quote.id,
        blockchain: c.blockchain,
        useCase: p.useCase,
        reasonForPayment: p.reasonForPayment,
        customerRefId: p.customerRefId,
        ...(p.refCode ? { refCode: p.refCode } : {}),
        senderAddress: p.senderAddress,
        refundAddress: p.refundAddress,
        ...enc,
      });
      const transaction = await cpn.createTransaction(payment.id);
      return { payment, transaction };
    },

    /**
     * Sign the payment intent and broadcast. IRREVERSIBLE — once broadcast, the
     * sender's USDC leaves. `signer` is the funds owner's account (host env).
     */
    async submit(
      args: { paymentId: string; transaction: CpnTransaction },
      signer: Account,
    ): Promise<CpnTransaction> {
      const signature = await signPaymentIntent(signer, args.transaction.messageToBeSigned);
      return cpn.submitTransaction(args.paymentId, args.transaction.id, signature);
    },

    /** Current payment status (poll to follow the async lifecycle). */
    status(paymentId: string): Promise<CpnPayment> {
      return cpn.getPayment(paymentId);
    },
  };
}

export type CpnRamp = ReturnType<typeof createCpnRamp>;
