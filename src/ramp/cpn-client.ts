/**
 * CPN (Circle Payments Network) client — the OFI / Sending side.
 *
 * RivoKit acts as an Originating Financial Institution: it takes USDC on-chain
 * and instructs a payout in the beneficiary's local currency, settled by a BFI
 * on the other end of the network. This module is the typed surface over the
 * `/v1/cpn` REST API. It covers the read endpoints today (overview, routes) —
 * both verified live against sandbox by scripts/probe-cpn.mjs — and leaves a
 * generic `request` for the quote -> payment -> transaction flow built on top.
 *
 * Three things shape the design:
 *
 *   - Auth is a plain Bearer of the CPN key (CIRCLE_CPN_KEY), NOT the W3S
 *     entity-secret ciphertext that scripts/lib/circle.mjs uses. CPN's mutating
 *     calls are authorized by an EIP-712 signature from the funds owner, added
 *     in a later stage — not by an entity secret.
 *
 *   - Every call goes to api.circle.com, which the build network's ISP hijacks
 *     via DNS. We install the DNS pinning (src/lib/circle-dns.ts) on construction
 *     so callers can't forget; it is idempotent and leaves TLS verification on.
 *
 *   - Source is always USDC and the payout currency/method/chain vary by
 *     destination. So route selection is parameterized, never hardcoded to one
 *     corridor — the demo defaults to EUR/SEPA on Arc, but the same client
 *     serves USD/WIRE, other countries, and other chains unchanged.
 */
import { randomUUID } from "node:crypto";
import { installCircleDnsPinning } from "../lib/circle-dns.ts";
import type { MessageToBeSigned } from "./cpn-sign.ts";

const DEFAULT_BASE = "https://api.circle.com";

/** A single payout rail for a (sourceCurrency, destinationCountry) pair. */
export type CpnRoute = {
  destinationCurrency: string;
  /** e.g. "SEPA", "WIRE". */
  paymentMethodType: string;
  /** The chain the USDC is sent from, e.g. "ARC-TESTNET". */
  blockchain: string;
  fiatLimit: { min: string; max: string; currency: string };
  cryptoLimit: { min: string; max: string; currency: string };
  useCases: string[];
};

export type CpnOverview = {
  sourceCurrencies: string[];
  destinationCountries: string[];
};

/** A money value as CPN returns it — decimal string plus ISO/token currency. */
export type CpnAmount = { amount: string; currency: string };

/**
 * The fee kinds CPN itemizes. Verified live so far: BFI_TRANSACTION_FEE and
 * BLOCKCHAIN_GAS_FEE; TAX_FEE and CIRCLE_SERVICE_FEE are documented and appear
 * on other corridors. Kept open (string) so an unseen kind never breaks parsing.
 */
export type CpnFee = { type: string; amount: CpnAmount };
export type CpnFees = { totalAmount: CpnAmount; breakdown: CpnFee[] };

export type CpnExchangeRate = { rate: string; pair: string };

/** EC P-256 public key the payment PII is encrypted to (see cpn-encrypt.ts). */
export type CpnJwk = { kty: string; crv: string; kid?: string; x: string; y: string };
export type CpnCertificate = { id: string; certPem: string; domain: string; jwk: CpnJwk };

export type CpnParty = "BUSINESS" | "CONSUMER";

/** One quote. Note createQuote returns an ARRAY of these; the client unwraps it. */
export type CpnQuote = {
  type: "quote";
  id: string;
  paymentMethodType: string;
  blockchain: string;
  senderCountry: string;
  destinationCountry: string;
  createDate: string;
  /** ~30-60s out. The whole payment must be built and funded before this. */
  quoteExpireDate: string;
  cryptoFundsSettlementExpireDate: string;
  sourceAmount: CpnAmount;
  destinationAmount: CpnAmount;
  fiatSettlementTime: { min: string; max: string; unit: string };
  /** The rate actually applied (includes CPN's FX margin). */
  exchangeRate: CpnExchangeRate;
  /** The mid/raw rate before margin — the spread between the two is the FX fee. */
  rawExchangeRate: CpnExchangeRate;
  fees: CpnFees;
  senderType: CpnParty;
  recipientType: CpnParty;
  certificate: CpnCertificate;
  quoteOptions?: Record<string, unknown>;
  transactionVersion: string;
};

export type CreateQuoteParams = {
  senderType: CpnParty;
  recipientType: CpnParty;
  /** ISO-3166 alpha-2 of the sender/originator. */
  senderCountry: string;
  destinationCountry: string;
  blockchain: string;
  paymentMethodType: string;
  sourceCurrency: string;
  destinationCurrency: string;
  /** Provide EXACTLY ONE of these; CPN quotes the other side. */
  sourceAmount?: string;
  destinationAmount?: string;
  /** Arc requires "VERSION_2"; defaulted when omitted. */
  transactionVersion?: string;
};

/** A required/optional field CPN wants for a given quote. type is TEXT | ADDRESS. */
export type CpnRequirementField = { name: string; type: string; optional: boolean };
export type CpnPaymentRequirements = {
  travelRule: CpnRequirementField[];
  beneficiaryAccount: CpnRequirementField[];
};

/** Payment lifecycle: CREATED → CRYPTO_FUNDS_PENDING → FIAT_PAYMENT_INITIATED → COMPLETED (| FAILED). */
export type CpnPaymentStatus =
  | "CREATED"
  | "CRYPTO_FUNDS_PENDING"
  | "FIAT_PAYMENT_INITIATED"
  | "COMPLETED"
  | "FAILED"
  | (string & {});

export type CpnPayment = {
  type: "payment";
  id: string;
  quoteId: string;
  blockchain: string;
  senderAddress: string;
  refundAddress: string;
  paymentMethodType: string;
  sourceAmount: CpnAmount;
  destinationAmount: CpnAmount;
  status: CpnPaymentStatus;
  refCode?: string;
  customerRefId?: string;
  useCase: string;
  reasonForPayment: string;
  /** The onchain funding transaction must be submitted before this. */
  expireDate: string;
  createDate: string;
  fees: CpnFees;
  /**
   * The funding transfers CPN saw on-chain. `transactionHash` is the only place
   * the Arc hash for a broadcast payout surfaces — `submitTransaction` returns
   * before the transaction is mined and so cannot carry one (verified live
   * 2026-07-31 against payment `61d22d57…`).
   */
  onChainTransactions?: Array<{
    type?: string;
    id?: string;
    status?: string;
    transactionHash?: string;
  }>;
  rfis?: unknown[];
  refunds?: unknown[];
  metadata?: Record<string, unknown>;
  failureReason?: string;
  failureCode?: string;
  /**
   * The rail's own reference for the fiat transfer — and the ONLY artefact that
   * crosses into the beneficiary's world.
   *
   * Circle returns it when the rail cannot carry the sender's name or a memo
   * separately, and documents it as "visible to the beneficiary on their bank
   * statement" (cpn/concepts/payments/payment-reference). That makes it the
   * handle a real recipient would use to confirm the money arrived — which
   * matters because nothing on our side can observe the fiat leg landing.
   *
   * Observed live on the USD/WIRE payment as `RE78dzv7…`. Optional: rails with
   * full metadata support carry `refCode` in the memo instead.
   */
  fiatNetworkPaymentRef?: string;
  /** Rail's estimate of when fiat settles, e.g. `{min:"1", max:"3", unit:"days"}`. */
  fiatSettlementTime?: { min: string; max: string; unit: string };
};

export type CreatePaymentParams = {
  quoteId: string;
  blockchain: string;
  useCase: string;
  /** Enum PMT001..PMT030. */
  reasonForPayment: string;
  customerRefId: string;
  refCode?: string;
  /** Onchain address of the USDC sender (funds owner). */
  senderAddress: string;
  /** Onchain address to refund USDC to if the payment fails. */
  refundAddress: string;
  /** JWE strings from encryptPaymentData (see cpn-encrypt.ts). */
  travelRuleData: string;
  beneficiaryAccountData: string;
  /** Defaulted to a fresh UUID by createPayment when omitted. */
  idempotencyKey?: string;
};

/** An onchain transaction with the EIP-712 intent to sign. */
export type CpnTransaction = {
  id: string;
  status: string;
  paymentId: string;
  expireDate: string;
  blockchain: string;
  senderAddress: string;
  destinationAddress: string;
  amount: CpnAmount;
  messageType: string;
  messageToBeSigned: MessageToBeSigned;
};

/**
 * Assemble the createPayment body. Pure (idempotencyKey passed in), so the
 * envelope shape is unit-tested without a network call.
 */
export function buildPaymentBody(p: CreatePaymentParams & { idempotencyKey: string }): Record<string, unknown> {
  return {
    idempotencyKey: p.idempotencyKey,
    quoteId: p.quoteId,
    blockchain: p.blockchain,
    useCase: p.useCase,
    reasonForPayment: p.reasonForPayment,
    customerRefId: p.customerRefId,
    ...(p.refCode ? { refCode: p.refCode } : {}),
    senderAddress: p.senderAddress,
    refundAddress: p.refundAddress,
    travelRuleData: p.travelRuleData,
    beneficiaryAccountData: p.beneficiaryAccountData,
  };
}

export type RouteQuery = {
  sourceCurrency: string;
  /** ISO-3166 alpha-2, e.g. "FR". */
  destinationCountry: string;
};

/** What to match a route on. Any field left out is a wildcard. */
export type RouteSelector = {
  destinationCurrency?: string;
  paymentMethodType?: string;
  blockchain?: string;
};

export class CpnError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`CPN HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "CpnError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Pick one route from a list by an exact-match selector. Pure — no network — so
 * it is unit-tested directly. Returns the first match in the list's order, or
 * `null` if nothing matches, letting the caller decide how to fail (a missing
 * corridor is a business condition, not an exception).
 */
export function pickRoute(routes: CpnRoute[], selector: RouteSelector): CpnRoute | null {
  return (
    routes.find(
      (r) =>
        (selector.destinationCurrency === undefined ||
          r.destinationCurrency === selector.destinationCurrency) &&
        (selector.paymentMethodType === undefined ||
          r.paymentMethodType === selector.paymentMethodType) &&
        (selector.blockchain === undefined || r.blockchain === selector.blockchain),
    ) ?? null
  );
}

/**
 * Shape a createQuote request body from ergonomic params. CPN wants sourceAmount
 * and destinationAmount as `{amount?, currency}` objects with the amount on
 * EXACTLY ONE side — this enforces that rule client-side so a bad call fails
 * here with a clear message instead of as a 400 round-trip. Pure; unit-tested.
 */
export function buildQuoteBody(p: CreateQuoteParams): Record<string, unknown> {
  const hasSource = p.sourceAmount !== undefined;
  const hasDest = p.destinationAmount !== undefined;
  if (hasSource === hasDest) {
    throw new Error(
      "buildQuoteBody: give an amount on EXACTLY ONE side — sourceAmount OR destinationAmount, never both and never neither",
    );
  }
  return {
    senderType: p.senderType,
    recipientType: p.recipientType,
    senderCountry: p.senderCountry,
    destinationCountry: p.destinationCountry,
    blockchain: p.blockchain,
    paymentMethodType: p.paymentMethodType,
    transactionVersion: p.transactionVersion ?? "VERSION_2",
    sourceAmount: hasSource
      ? { amount: p.sourceAmount, currency: p.sourceCurrency }
      : { currency: p.sourceCurrency },
    destinationAmount: hasDest
      ? { amount: p.destinationAmount, currency: p.destinationCurrency }
      : { currency: p.destinationCurrency },
  };
}

/** Total fee plus a by-type map, for display and reconciliation. Pure. */
export function summarizeQuoteFees(quote: CpnQuote): {
  total: CpnAmount;
  byType: Record<string, string>;
} {
  const byType: Record<string, string> = {};
  for (const f of quote.fees.breakdown) byType[f.type] = f.amount.amount;
  return { total: quote.fees.totalAmount, byType };
}

/**
 * CPN's FX margin, in basis points, as the gap between the raw (mid) rate and
 * the applied rate: (raw - applied) / raw * 10000. This margin is charged
 * implicitly in the rate, separately from `fees.breakdown`. Pure.
 */
export function quoteSpreadBps(quote: CpnQuote): number {
  const raw = Number(quote.rawExchangeRate.rate);
  const applied = Number(quote.exchangeRate.rate);
  if (!raw) return 0;
  return ((raw - applied) / raw) * 10_000;
}

export type CreateCpnClientParams = {
  apiKey: string;
  /** Override only in tests. */
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export function createCpnClient(params: CreateCpnClientParams) {
  const apiKey = params.apiKey;
  if (!apiKey) throw new Error("createCpnClient: apiKey (CIRCLE_CPN_KEY) is empty");
  const base = params.baseUrl ?? DEFAULT_BASE;
  const doFetch = params.fetchImpl ?? fetch;

  // Pin Circle's DNS before the first call. Idempotent; TLS stays verified.
  installCircleDnsPinning();

  /**
   * One request. Unwraps Circle's `{ data: ... }` envelope, and throws CpnError
   * on any non-2xx so callers never branch on a status they forgot to check.
   */
  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) throw new CpnError(res.status, parsed);
    const env = parsed as { data?: T } | null;
    return (env?.data ?? (parsed as T)) as T;
  }

  return {
    request,

    /** Source currencies and destination countries this account can send to. */
    getOverview(): Promise<CpnOverview> {
      return request<CpnOverview>("GET", "/v1/cpn/configurations/overview");
    },

    /**
     * Payout rails for a corridor. Both query params are required by the API —
     * omitting either is a 400, not an empty list.
     */
    listRoutes(query: RouteQuery): Promise<CpnRoute[]> {
      const qs = new URLSearchParams({
        sourceCurrency: query.sourceCurrency,
        destinationCountry: query.destinationCountry,
      });
      return request<CpnRoute[]>("GET", `/v1/cpn/configurations/routes?${qs}`);
    },

    /** Fetch a corridor's routes and select one in a single call. */
    async findRoute(query: RouteQuery, selector: RouteSelector): Promise<CpnRoute | null> {
      return pickRoute(await this.listRoutes(query), selector);
    },

    /**
     * Request a quote. The API returns an array of candidate quotes; we take the
     * first. The returned quote carries the fees, the applied rate, a ~30-60s
     * expiry, and the certificate/JWK used to encrypt the payment's PII.
     */
    async createQuote(params: CreateQuoteParams): Promise<CpnQuote> {
      const res = await request<CpnQuote[] | CpnQuote>("POST", "/v1/cpn/quotes", buildQuoteBody(params));
      const quote = Array.isArray(res) ? res[0] : res;
      if (!quote) throw new CpnError(200, "createQuote: empty response (no quote)");
      return quote;
    },

    /**
     * The Travel Rule and beneficiary-account fields required for a specific
     * quote's corridor. Which fields are mandatory depends on the route (e.g.
     * SEPA needs IBAN + RECIPIENT_LEGAL_NAME), so this is keyed by quoteId.
     */
    getPaymentRequirements(quoteId: string): Promise<CpnPaymentRequirements> {
      const qs = new URLSearchParams({ quoteId });
      return request<CpnPaymentRequirements>("GET", `/v1/cpn/payments/requirements?${qs}`);
    },

    /**
     * Create a payment from an accepted quote and the encrypted PII. Returns a
     * payment in CRYPTO_FUNDS_PENDING — no funds have moved yet; the onchain
     * transaction (createTransaction → sign → submit) does that. Must happen
     * before the quote expires.
     */
    createPayment(params: CreatePaymentParams): Promise<CpnPayment> {
      const body = buildPaymentBody({ ...params, idempotencyKey: params.idempotencyKey ?? randomUUID() });
      return request<CpnPayment>("POST", "/v1/cpn/payments", body);
    },

    getPayment(paymentId: string): Promise<CpnPayment> {
      return request<CpnPayment>("GET", `/v1/cpn/payments/${paymentId}`);
    },

    /**
     * Prepare the onchain funding transaction (V2). Returns the unsigned
     * `messageToBeSigned` (a Permit2 intent) for the funds owner to sign. This
     * does NOT broadcast — submitTransaction does.
     */
    createTransaction(paymentId: string, idempotencyKey?: string): Promise<CpnTransaction> {
      return request<CpnTransaction>("POST", `/v2/cpn/payments/${paymentId}/transactions`, {
        idempotencyKey: idempotencyKey ?? randomUUID(),
      });
    },

    getTransaction(paymentId: string, transactionId: string): Promise<CpnTransaction> {
      return request<CpnTransaction>("GET", `/v2/cpn/payments/${paymentId}/transactions/${transactionId}`);
    },

    /**
     * Submit the signed intent — this BROADCASTS onchain and is the point of no
     * return: once the transaction reaches BROADCASTED, funds leave the sender
     * irreversibly. `signedTransaction` is the EIP-712 signature from
     * signPaymentIntent (cpn-sign.ts).
     */
    submitTransaction(
      paymentId: string,
      transactionId: string,
      signedTransaction: string,
    ): Promise<CpnTransaction> {
      return request<CpnTransaction>(
        "POST",
        `/v2/cpn/payments/${paymentId}/transactions/${transactionId}/submit`,
        { signedTransaction },
      );
    },
  };
}

export type CpnClient = ReturnType<typeof createCpnClient>;
