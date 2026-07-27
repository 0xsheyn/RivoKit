import { describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { privateKeyToAccount } from "viem/accounts";
import { createCpnRamp, type RampCorridor } from "./cpn-ramp.ts";
import type { CpnClient, CpnQuote } from "./cpn-client.ts";
import { signPaymentIntent, type MessageToBeSigned } from "./cpn-sign.ts";

const corridor: RampCorridor = {
  senderType: "BUSINESS",
  recipientType: "BUSINESS",
  senderCountry: "US",
  destinationCountry: "FR",
  blockchain: "ARC-TESTNET",
  paymentMethodType: "SEPA",
  sourceCurrency: "USDC",
  destinationCurrency: "EUR",
};

const SAMPLE_MSG: MessageToBeSigned = {
  domain: { name: "Permit2", chainId: "5042002", verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  message: { spender: "0x355e0a2a4B7563e0E00C90deD9Aa914c119Ee868", nonce: "1", deadline: "2" },
  primaryType: "Intent",
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Intent: [
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
};

async function fakeQuote(): Promise<CpnQuote> {
  const { publicKey } = await generateKeyPair("ECDH-ES+A128KW", { crv: "P-256", extractable: true });
  const jwk = (await exportJWK(publicKey)) as CpnQuote["certificate"]["jwk"];
  return {
    type: "quote",
    id: "q1",
    paymentMethodType: "SEPA",
    blockchain: "ARC-TESTNET",
    senderCountry: "US",
    destinationCountry: "FR",
    createDate: "",
    quoteExpireDate: "",
    cryptoFundsSettlementExpireDate: "",
    sourceAmount: { amount: "20.000000", currency: "USDC" },
    destinationAmount: { amount: "17.30", currency: "EUR" },
    fiatSettlementTime: { min: "0", max: "30", unit: "MINUTES" },
    exchangeRate: { rate: "0.865000", pair: "USDC/EUR" },
    rawExchangeRate: { rate: "0.876051", pair: "USDC/EUR" },
    fees: {
      totalAmount: { amount: "0.252302", currency: "USDC" },
      breakdown: [{ type: "BFI_TRANSACTION_FEE", amount: { amount: "0.242302", currency: "USDC" } }],
    },
    senderType: "BUSINESS",
    recipientType: "BUSINESS",
    certificate: { id: "c1", certPem: "", domain: "api.circle.com", jwk },
    transactionVersion: "VERSION_2",
  };
}

function mockClient(quote: CpnQuote) {
  const rec: { payment?: any; submit?: any } = {};
  const client = {
    createQuote: vi.fn(async () => quote),
    createPayment: vi.fn(async (body: any) => {
      rec.payment = body;
      return { id: "pay1", status: "CRYPTO_FUNDS_PENDING" };
    }),
    createTransaction: vi.fn(async (paymentId: string) => ({ id: "tx1", paymentId, messageToBeSigned: SAMPLE_MSG })),
    submitTransaction: vi.fn(async (paymentId: string, transactionId: string, signedTransaction: string) => {
      rec.submit = { paymentId, transactionId, signedTransaction };
      return { id: transactionId, status: "PENDING" };
    }),
    getPayment: vi.fn(async (id: string) => ({ id, status: "CRYPTO_FUNDS_PENDING" })),
  } as unknown as CpnClient;
  return { client, rec };
}

const prepareInput = {
  travelRule: [{ name: "ORIGINATOR_NAME", value: "Rivo Co" }],
  beneficiaryAccount: [{ name: "IBAN", value: "FR7630006000011234567890189" }],
  senderAddress: "0xabc",
  refundAddress: "0xabc",
  useCase: "B2B",
  reasonForPayment: "PMT001",
  customerRefId: "ref-1",
};

describe("createCpnRamp", () => {
  it("quote returns the quote with a fee summary and FX spread", async () => {
    const quote = await fakeQuote();
    const { client } = mockClient(quote);
    const ramp = createCpnRamp({ apiKey: "k", corridor, client });

    const r = await ramp.quote({ sourceAmount: "20" });
    expect(r.quote.id).toBe("q1");
    expect(r.fees.byType.BFI_TRANSACTION_FEE).toBe("0.242302");
    expect(Math.round(r.spreadBps)).toBe(126);
  });

  it("prepare encrypts the PII and creates payment + transaction without submitting", async () => {
    const quote = await fakeQuote();
    const { client, rec } = mockClient(quote);
    const ramp = createCpnRamp({ apiKey: "k", corridor, client });

    const { payment, transaction } = await ramp.prepare({ quote, ...prepareInput });

    // Encrypted JWE strings (5-part compact) went into the payment body.
    expect(rec.payment.travelRuleData.split(".")).toHaveLength(5);
    expect(rec.payment.beneficiaryAccountData.split(".")).toHaveLength(5);
    expect(rec.payment.quoteId).toBe("q1");
    expect(payment.id).toBe("pay1");
    expect(transaction.messageToBeSigned.primaryType).toBe("Intent");
    expect(rec.submit).toBeUndefined(); // NOT broadcast
  });

  it("submit signs the intent and broadcasts the signature", async () => {
    const quote = await fakeQuote();
    const { client, rec } = mockClient(quote);
    const ramp = createCpnRamp({ apiKey: "k", corridor, client });
    const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

    const tx = await ramp.prepare({ quote, ...prepareInput }).then((r) => r.transaction);
    const submitted = await ramp.submit({ paymentId: "pay1", transaction: tx }, signer);

    expect(submitted.status).toBe("PENDING");
    expect(rec.submit.paymentId).toBe("pay1");
    expect(rec.submit.transactionId).toBe("tx1");
    expect(rec.submit.signedTransaction).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  it("submitSigned broadcasts a signature produced elsewhere, without an account", async () => {
    const quote = await fakeQuote();
    const { client, rec } = mockClient(quote);
    const ramp = createCpnRamp({ apiKey: "k", corridor, client });

    const tx = await ramp.prepare({ quote, ...prepareInput }).then((r) => r.transaction);
    // What a browser wallet hands back: a signature, and nothing else. No
    // Account object is reachable from where the API key lives.
    const signature = `0x${"ab".repeat(65)}` as const;
    const submitted = await ramp.submitSigned({ paymentId: "pay1", transaction: tx }, signature);

    expect(submitted.status).toBe("PENDING");
    expect(rec.submit).toMatchObject({ paymentId: "pay1", transactionId: "tx1", signedTransaction: signature });
  });

  it("submit and submitSigned reach the API identically — the same call, signed in two places", async () => {
    const quote = await fakeQuote();
    const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

    const a = mockClient(quote);
    const rampA = createCpnRamp({ apiKey: "k", corridor, client: a.client });
    const txA = await rampA.prepare({ quote, ...prepareInput }).then((r) => r.transaction);
    await rampA.submit({ paymentId: "pay1", transaction: txA }, signer);

    // Sign separately (as the browser would), then broadcast through submitSigned.
    const b = mockClient(quote);
    const rampB = createCpnRamp({ apiKey: "k", corridor, client: b.client });
    const txB = await rampB.prepare({ quote, ...prepareInput }).then((r) => r.transaction);
    const signature = await signPaymentIntent(signer, txB.messageToBeSigned);
    await rampB.submitSigned({ paymentId: "pay1", transaction: txB }, signature);

    expect(b.rec.submit).toEqual(a.rec.submit);
  });
});
