import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  applyPaymentEvent,
  interpretCpnEvent,
  isPaymentTerminal,
  isPointOfNoReturn,
  rfiEffect,
  verifyAndInterpretCpn,
  type CpnEvent,
} from "./cpn-state.ts";

const paymentEvent = (notificationType: string, id = "pay-1"): CpnEvent => ({
  component: "payment",
  notificationType,
  paymentId: id,
  raw: {},
});

describe("interpretCpnEvent", () => {
  it("classifies each CPN component from the notificationType", () => {
    expect(interpretCpnEvent({ notificationType: "cpn.payment.completed", notification: { id: "p1" } }))
      .toMatchObject({ component: "payment", paymentId: "p1" });
    expect(interpretCpnEvent({ notificationType: "cpn.rfi.approved", notification: { paymentId: "p2" } }))
      .toMatchObject({ component: "rfi", paymentId: "p2" });
    expect(interpretCpnEvent({ notificationType: "cpn.transaction.broadcasted", notification: {} }))
      .toMatchObject({ component: "transaction" });
    expect(interpretCpnEvent({ notificationType: "cpn.refund.created", notification: {} }))
      .toMatchObject({ component: "refund" });
  });

  it("returns null for a non-CPN or malformed payload", () => {
    expect(interpretCpnEvent({ notificationType: "transactions.inbound" })).toBeNull();
    expect(interpretCpnEvent({})).toBeNull();
    expect(interpretCpnEvent(null)).toBeNull();
  });
});

describe("applyPaymentEvent", () => {
  it("advances forward through the happy path", () => {
    let s = applyPaymentEvent("CREATED", paymentEvent("cpn.payment.cryptoFundsPending"));
    expect(s).toEqual({ state: "CRYPTO_FUNDS_PENDING", changed: true });
    s = applyPaymentEvent(s.state, paymentEvent("cpn.payment.fiatPaymentInitiated"));
    expect(s).toEqual({ state: "FIAT_PAYMENT_INITIATED", changed: true });
    s = applyPaymentEvent(s.state, paymentEvent("cpn.payment.completed"));
    expect(s).toEqual({ state: "COMPLETED", changed: true });
  });

  it("can fail from any non-terminal state", () => {
    expect(applyPaymentEvent("CREATED", paymentEvent("cpn.payment.failed")).state).toBe("FAILED");
    expect(applyPaymentEvent("CRYPTO_FUNDS_PENDING", paymentEvent("cpn.payment.failed")).state).toBe("FAILED");
  });

  it("ignores a duplicate event for the current state", () => {
    expect(applyPaymentEvent("CRYPTO_FUNDS_PENDING", paymentEvent("cpn.payment.cryptoFundsPending")))
      .toEqual({ state: "CRYPTO_FUNDS_PENDING", changed: false, reason: "duplicate" });
  });

  it("ignores a backward / out-of-order event", () => {
    // A late cryptoFundsPending after fiatPaymentInitiated must not regress.
    expect(applyPaymentEvent("FIAT_PAYMENT_INITIATED", paymentEvent("cpn.payment.cryptoFundsPending")))
      .toEqual({ state: "FIAT_PAYMENT_INITIATED", changed: false, reason: "illegal" });
  });

  it("never moves out of a terminal state", () => {
    expect(applyPaymentEvent("COMPLETED", paymentEvent("cpn.payment.failed")))
      .toEqual({ state: "COMPLETED", changed: false, reason: "illegal" });
    expect(isPaymentTerminal("FAILED")).toBe(true);
  });

  it("treats delayed / inManualReview as no-ops (no state change)", () => {
    expect(applyPaymentEvent("CRYPTO_FUNDS_PENDING", paymentEvent("cpn.payment.delayed")).changed).toBe(false);
    expect(applyPaymentEvent("CREATED", paymentEvent("cpn.payment.inManualReview")))
      .toEqual({ state: "CREATED", changed: false, reason: "no-op" });
  });

  it("ignores non-payment events", () => {
    const e: CpnEvent = { component: "rfi", notificationType: "cpn.rfi.approved", raw: {} };
    expect(applyPaymentEvent("CREATED", e)).toMatchObject({ changed: false, reason: "not-payment" });
  });
});

describe("isPointOfNoReturn", () => {
  it("is true only once broadcast", () => {
    expect(isPointOfNoReturn("PENDING")).toBe(false);
    expect(isPointOfNoReturn("BROADCASTED")).toBe(true);
    expect(isPointOfNoReturn("COMPLETED")).toBe(true);
  });
});

describe("rfiEffect", () => {
  it("blocks the payment while information is required or in review", () => {
    expect(rfiEffect(paymentEvent("cpn.rfi.informationRequired"))).toMatchObject({ blocksPayment: true, failsPayment: false });
    expect(rfiEffect(paymentEvent("cpn.rfi.inReview"))).toMatchObject({ blocksPayment: true });
  });
  it("fails the payment on rejection and unblocks on approval", () => {
    expect(rfiEffect(paymentEvent("cpn.rfi.rejected"))).toMatchObject({ state: "FAILED", failsPayment: true });
    expect(rfiEffect(paymentEvent("cpn.rfi.approved"))).toMatchObject({ blocksPayment: false, failsPayment: false });
  });
});

describe("verifyAndInterpretCpn", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pubPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const body = JSON.stringify({ notificationType: "cpn.payment.completed", notification: { id: "p9" } });
  const goodSig = sign("sha256", Buffer.from(body, "utf8"), privateKey).toString("base64");

  it("verifies the signature then interprets the event", () => {
    const e = verifyAndInterpretCpn({ rawBody: body, signatureBase64: goodSig, publicKey: pubPem });
    expect(e).toMatchObject({ component: "payment", notificationType: "cpn.payment.completed", paymentId: "p9" });
  });

  it("throws on a bad signature before interpreting anything", () => {
    const otherBody = JSON.stringify({ notificationType: "cpn.payment.failed", notification: { id: "p9" } });
    expect(() => verifyAndInterpretCpn({ rawBody: otherBody, signatureBase64: goodSig, publicKey: pubPem })).toThrow();
  });
});
