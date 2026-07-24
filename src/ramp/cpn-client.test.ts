import { describe, expect, it } from "vitest";
import {
  buildPaymentBody,
  buildQuoteBody,
  pickRoute,
  quoteSpreadBps,
  summarizeQuoteFees,
  type CpnQuote,
  type CpnRoute,
} from "./cpn-client.ts";

/** A minimal route factory — only the fields pickRoute reads matter here. */
function route(
  destinationCurrency: string,
  paymentMethodType: string,
  blockchain: string,
): CpnRoute {
  return {
    destinationCurrency,
    paymentMethodType,
    blockchain,
    fiatLimit: { min: "0", max: "1", currency: destinationCurrency },
    cryptoLimit: { min: "0", max: "1", currency: "USDC" },
    useCases: [],
  };
}

// Mirrors the real FR corridor shape verified by scripts/probe-cpn.mjs: the same
// currency appears on several chains, and several currencies share a chain.
const FR: CpnRoute[] = [
  route("EUR", "SEPA", "ETH-SEPOLIA"),
  route("EUR", "SEPA", "ARC-TESTNET"),
  route("EUR", "WIRE", "ARC-TESTNET"),
  route("USD", "WIRE", "ARC-TESTNET"),
];

describe("pickRoute", () => {
  it("selects the EUR/SEPA rail on Arc — the demo corridor", () => {
    const r = pickRoute(FR, {
      destinationCurrency: "EUR",
      paymentMethodType: "SEPA",
      blockchain: "ARC-TESTNET",
    });
    expect(r).not.toBeNull();
    expect(r?.blockchain).toBe("ARC-TESTNET");
    expect(r?.paymentMethodType).toBe("SEPA");
  });

  it("disambiguates same currency across chains by blockchain", () => {
    const r = pickRoute(FR, { destinationCurrency: "EUR", paymentMethodType: "SEPA", blockchain: "ETH-SEPOLIA" });
    expect(r?.blockchain).toBe("ETH-SEPOLIA");
  });

  it("treats an omitted field as a wildcard, returning the first match in order", () => {
    const r = pickRoute(FR, { destinationCurrency: "EUR" });
    // First EUR row in list order is the ETH-SEPOLIA one.
    expect(r?.blockchain).toBe("ETH-SEPOLIA");
  });

  it("returns null when the corridor has no matching rail — a business condition, not a throw", () => {
    expect(pickRoute(FR, { destinationCurrency: "GBP" })).toBeNull();
    expect(pickRoute(FR, { destinationCurrency: "USD", paymentMethodType: "SEPA" })).toBeNull();
  });

  it("returns null on an empty route list", () => {
    expect(pickRoute([], { destinationCurrency: "EUR" })).toBeNull();
  });
});

const baseQuoteParams = {
  senderType: "BUSINESS" as const,
  recipientType: "BUSINESS" as const,
  senderCountry: "US",
  destinationCountry: "FR",
  blockchain: "ARC-TESTNET",
  paymentMethodType: "SEPA",
  sourceCurrency: "USDC",
  destinationCurrency: "EUR",
};

describe("buildQuoteBody", () => {
  it("puts the amount on the source side and defaults VERSION_2", () => {
    const body = buildQuoteBody({ ...baseQuoteParams, sourceAmount: "20" });
    expect(body.sourceAmount).toEqual({ amount: "20", currency: "USDC" });
    expect(body.destinationAmount).toEqual({ currency: "EUR" });
    expect(body.transactionVersion).toBe("VERSION_2");
  });

  it("puts the amount on the destination side when that is given", () => {
    const body = buildQuoteBody({ ...baseQuoteParams, destinationAmount: "17.30" });
    expect(body.destinationAmount).toEqual({ amount: "17.30", currency: "EUR" });
    expect(body.sourceAmount).toEqual({ currency: "USDC" });
  });

  it("rejects giving an amount on both sides", () => {
    expect(() => buildQuoteBody({ ...baseQuoteParams, sourceAmount: "20", destinationAmount: "17" })).toThrow();
  });

  it("rejects giving an amount on neither side", () => {
    expect(() => buildQuoteBody(baseQuoteParams)).toThrow();
  });
});

// A trimmed real quote (scripts/probe-cpn-quote.mjs) — only the fee/rate fields matter.
const SAMPLE_QUOTE = {
  exchangeRate: { rate: "0.865000", pair: "USDC/EUR" },
  rawExchangeRate: { rate: "0.876051", pair: "USDC/EUR" },
  fees: {
    totalAmount: { amount: "0.252302", currency: "USDC" },
    breakdown: [
      { type: "BFI_TRANSACTION_FEE", amount: { amount: "0.242302", currency: "USDC" } },
      { type: "BLOCKCHAIN_GAS_FEE", amount: { amount: "0.010000", currency: "USDC" } },
    ],
  },
} as unknown as CpnQuote;

describe("summarizeQuoteFees", () => {
  it("returns the total and a by-type breakdown", () => {
    const s = summarizeQuoteFees(SAMPLE_QUOTE);
    expect(s.total.amount).toBe("0.252302");
    expect(s.byType.BFI_TRANSACTION_FEE).toBe("0.242302");
    expect(s.byType.BLOCKCHAIN_GAS_FEE).toBe("0.010000");
  });
});

describe("quoteSpreadBps", () => {
  it("computes the FX margin between raw and applied rate in bps", () => {
    // (0.876051 - 0.865000) / 0.876051 * 10000 ≈ 126 bps
    expect(Math.round(quoteSpreadBps(SAMPLE_QUOTE))).toBe(126);
  });
});

describe("buildPaymentBody", () => {
  const base = {
    quoteId: "q1",
    blockchain: "ARC-TESTNET",
    useCase: "B2B",
    reasonForPayment: "PMT001",
    customerRefId: "ref-1",
    senderAddress: "0xabc",
    refundAddress: "0xabc",
    travelRuleData: "jwe.travel",
    beneficiaryAccountData: "jwe.benef",
    idempotencyKey: "idem-1",
  };

  it("carries the encrypted PII strings and required scalars through", () => {
    const b = buildPaymentBody(base);
    expect(b.travelRuleData).toBe("jwe.travel");
    expect(b.beneficiaryAccountData).toBe("jwe.benef");
    expect(b.reasonForPayment).toBe("PMT001");
    expect(b.idempotencyKey).toBe("idem-1");
  });

  it("omits refCode when not provided, includes it when given", () => {
    expect("refCode" in buildPaymentBody(base)).toBe(false);
    expect(buildPaymentBody({ ...base, refCode: "rc-1" }).refCode).toBe("rc-1");
  });
});
