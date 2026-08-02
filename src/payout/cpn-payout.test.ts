import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { createCpnPayoutRail, permitAmountOf } from "./cpn-payout.ts";
import type { CpnTransaction } from "../ramp/cpn-client.ts";
import type { CpnRamp } from "../ramp/cpn-ramp.ts";

const JWK = { kty: "EC" } as never;

function mkQuote(over: Record<string, unknown> = {}) {
  return {
    id: "quote_1",
    quoteExpireDate: "2026-07-30T00:01:00.000Z",
    sourceAmount: { amount: "12.400000", currency: "USDC" },
    destinationAmount: { amount: "12.00", currency: "EUR" },
    certificate: { jwk: JWK },
    ...over,
  };
}

const TX = {
  id: "tx_1",
  status: "CREATED",
  paymentId: "pay_1",
  messageToBeSigned: { message: { permitted: { amount: "12400000" } } },
} as unknown as CpnTransaction;

function mkRamp(over: Partial<CpnRamp> = {}): CpnRamp {
  return {
    corridor: {
      senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US",
      destinationCountry: "FR", blockchain: "ARC-TESTNET", paymentMethodType: "SEPA",
      sourceCurrency: "USDC", destinationCurrency: "EUR",
    },
    client: {
      findRoute: vi.fn(async () => ({
        destinationCurrency: "EUR", paymentMethodType: "SEPA", blockchain: "ARC-TESTNET",
        cryptoLimit: { min: "11", max: "5000000", currency: "USDC" },
        fiatLimit: { min: "9", max: "4244284.01", currency: "EUR" },
        useCases: ["B2B"],
      })),
    },
    quote: vi.fn(async () => ({ quote: mkQuote(), fees: { total: {}, byType: {} }, spreadBps: 0 })),
    prepare: vi.fn(async () => ({ payment: { id: "pay_1", status: "CREATED" }, transaction: TX })),
    submitSigned: vi.fn(async () => ({ ...TX, status: "BROADCASTED" })),
    status: vi.fn(async () => ({ id: "pay_1", status: "COMPLETED" })),
    ...over,
  } as unknown as CpnRamp;
}

const details = {
  travelRule: [{ name: "ORIGINATOR_NAME", value: "Rivo Co" }],
  beneficiaryAccount: [{ name: "IBAN", value: "FR76" }],
  useCase: "B2B",
  reasonForPayment: "PMT001",
};

function mkRail(ramp: CpnRamp, over: Record<string, unknown> = {}) {
  return createCpnPayoutRail({
    ramp,
    corridor: "EUR-SEPA",
    destinationCountry: "FR",
    senderAddress: "0xseller",
    details: () => details,
    signIntent: vi.fn(async (): Promise<Hex> => "0xsig"),
    now: () => Math.floor(Date.parse("2026-07-30T00:00:30.000Z") / 1000),
    ...over,
  });
}

describe("limits — read from the route, never hardcoded", () => {
  it("converts the corridor's crypto limits to minor units", async () => {
    const limits = await mkRail(mkRamp()).limits();
    expect(limits).toEqual({
      minSourceMinor: 11_000_000n,
      maxSourceMinor: 5_000_000_000_000n,
      sourceCurrency: "USDC",
      destinationCurrency: "EUR",
      destinationScale: 2,
    });
  });

  it("says so plainly when the corridor has no route", async () => {
    const ramp = mkRamp({ client: { findRoute: vi.fn(async () => null) } as never });
    await expect(mkRail(ramp).limits()).rejects.toThrow(/no EUR\/SEPA route/);
  });
});

describe("quote — the destination side is what gets pinned", () => {
  it("asks CPN for a fixed destinationAmount, formatted at the fiat scale", async () => {
    const ramp = mkRamp();
    await mkRail(ramp).quote({ orderId: "ord_1", destinationMinor: 1200n, availableSourceMinor: 12_600_000n });

    // "12.00", not "12" and not 12.0 through a float: this is the number the
    // seller is guaranteed, so it travels as a string at the currency's scale.
    expect(ramp.quote).toHaveBeenCalledWith({ destinationAmount: "12.00" });
  });

  it("reports what the quote costs and delivers, in minor units", async () => {
    const q = await mkRail(mkRamp()).quote({ orderId: "ord_1", destinationMinor: 1200n, availableSourceMinor: 12_600_000n });
    expect(q.requiredSourceMinor).toBe(12_400_000n);
    expect(q.destinationMinor).toBe(1200n);
    expect(q.destinationCurrency).toBe("EUR");
    expect(q.expiresAt).toBe(Math.floor(Date.parse("2026-07-30T00:01:00.000Z") / 1000));
  });

  it("prepares the payment but does NOT broadcast", async () => {
    const ramp = mkRamp();
    await mkRail(ramp).quote({ orderId: "ord_1", destinationMinor: 1200n, availableSourceMinor: 12_600_000n });
    expect(ramp.prepare).toHaveBeenCalledOnce();
    expect(ramp.submitSigned).not.toHaveBeenCalled();
  });

  it("sends the beneficiary the settlement wallet as both sender and refund address", async () => {
    const ramp = mkRamp();
    await mkRail(ramp).quote({ orderId: "ord_1", destinationMinor: 1200n, availableSourceMinor: 12_600_000n });
    expect(ramp.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ senderAddress: "0xseller", refundAddress: "0xseller" }),
    );
  });
});

describe("ready — the allowance runs before the clock starts", () => {
  it("delegates to the injected allowance top-up", async () => {
    const ensureAllowance = vi.fn(async () => {});
    await mkRail(mkRamp(), { ensureAllowance }).ready!(12_600_000n);
    expect(ensureAllowance).toHaveBeenCalledWith(12_600_000n);
  });

  it("is a no-op when the host manages its own allowance", async () => {
    await expect(mkRail(mkRamp()).ready!(12_600_000n)).resolves.toBeUndefined();
  });
});

describe("submit — the irreversible step", () => {
  it("signs with the injected signer and broadcasts", async () => {
    const ramp = mkRamp();
    const signIntent = vi.fn(async (): Promise<Hex> => "0xsig");
    const rail = mkRail(ramp, { signIntent });
    const q = await rail.quote({ orderId: "ord_1", destinationMinor: 1200n, availableSourceMinor: 12_600_000n });

    const sub = await rail.submit(q);
    expect(signIntent).toHaveBeenCalledWith(TX.messageToBeSigned);
    expect(ramp.submitSigned).toHaveBeenCalledWith({ paymentId: "pay_1", transaction: TX }, "0xsig");
    expect(sub).toMatchObject({ paymentId: "pay_1", status: "BROADCASTED", requiredSourceMinor: 12_400_000n, destinationMinor: 1200n });
  });

  // The facade checks expiry too. Checking again here is one comparison
  // standing between a lapsed quote and an unrecallable broadcast.
  it("refuses to broadcast a lapsed quote", async () => {
    const ramp = mkRamp();
    const rail = mkRail(ramp, { now: () => Math.floor(Date.parse("2026-07-30T00:02:00.000Z") / 1000) });
    const q = await rail.quote({ orderId: "ord_1", destinationMinor: 1200n, availableSourceMinor: 12_600_000n });

    await expect(rail.submit(q)).rejects.toThrow(/expired/);
    expect(ramp.submitSigned).not.toHaveBeenCalled();
  });

  it("refuses a quote that never came from this rail", async () => {
    const rail = mkRail(mkRamp());
    await expect(
      rail.submit({
        requiredSourceMinor: 1n, destinationMinor: 1n, destinationCurrency: "EUR", destinationScale: 2,
        sourceCurrency: "USDC", expiresAt: 9_999_999_999, intent: { nonsense: true },
      }),
    ).rejects.toThrow(/not a prepared CPN payment/);
  });
});

describe("status — the polling fallback", () => {
  it("maps COMPLETED to delivered", async () => {
    expect(await mkRail(mkRamp()).status!("pay_1")).toMatchObject({ status: "COMPLETED", terminal: true, delivered: true });
  });

  it("maps FAILED to terminal but NOT delivered", async () => {
    const ramp = mkRamp({ status: vi.fn(async () => ({ status: "FAILED", failureReason: "rejected" })) as never });
    expect(await mkRail(ramp).status!("pay_1")).toMatchObject({ status: "FAILED", terminal: true, delivered: false, failureReason: "rejected" });
  });

  it("leaves an in-flight payment non-terminal", async () => {
    const ramp = mkRamp({ status: vi.fn(async () => ({ status: "FIAT_PAYMENT_INITIATED" })) as never });
    expect(await mkRail(ramp).status!("pay_1")).toMatchObject({ terminal: false, delivered: false });
  });
});

describe("permitAmountOf", () => {
  it("reads the Permit2 amount off a prepared intent", () => {
    expect(permitAmountOf(TX)).toBe(12_400_000n);
  });

  it("returns zero when the message carries no permit", () => {
    expect(permitAmountOf({ messageToBeSigned: { message: {} } } as never)).toBe(0n);
  });
});
