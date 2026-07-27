import { describe, expect, it, vi } from "vitest";
import { applyCpnEventToStore, type CpnSyncStore } from "./cpn-sync.ts";
import type { CpnEvent, CpnPaymentState } from "./cpn-state.ts";
import type { CpnPaymentRecord } from "../orchestrator/order-store.ts";

function record(status: CpnPaymentState): CpnPaymentRecord {
  return {
    payment_id: "pay_1", order_id: null, corridor: "EUR-SEPA",
    sender_address: "0x7d9EEb6883b3F649BF17bEB4bb108c578a65bcCA", signed_by: "wallet",
    source_minor: "15000000", source_currency: "USDC",
    destination_minor: "1294", destination_currency: "EUR", destination_scale: 2,
    status, transaction_id: null, failure_reason: null,
    created_at: "2026-07-28T00:00:00Z", updated_at: "2026-07-28T00:00:00Z",
  };
}

/** In-memory store that behaves like the real one: advance writes, get reads. */
function memStore(initial: CpnPaymentRecord | null) {
  let row = initial;
  const store = {
    getCpnPayment: vi.fn(async () => (row ? { ...row } : null)),
    advanceCpnPayment: vi.fn(async (_id: string, status: CpnPaymentState, patch = {}) => {
      row = { ...(row as CpnPaymentRecord), status, ...(patch.failureReason ? { failure_reason: patch.failureReason } : {}) };
      return { ...row };
    }),
    recordEvent: vi.fn(async () => {}),
  } satisfies CpnSyncStore;
  return { store, current: () => row };
}

const ev = (notificationType: string, component: CpnEvent["component"] = "payment"): CpnEvent => ({
  component, notificationType, paymentId: "pay_1", raw: { notificationType },
});

describe("applyCpnEventToStore", () => {
  it("advances the stored payment and writes it", async () => {
    const { store, current } = memStore(record("CRYPTO_FUNDS_PENDING"));

    const r = await applyCpnEventToStore(store, ev("cpn.payment.fiatPaymentInitiated"));

    expect(r).toMatchObject({ status: "advanced", from: "CRYPTO_FUNDS_PENDING", to: "FIAT_PAYMENT_INITIATED" });
    expect(current()?.status).toBe("FIAT_PAYMENT_INITIATED");
  });

  it("writes NOTHING for a duplicate — at-least-once delivery is normal", async () => {
    const { store } = memStore(record("COMPLETED"));

    const r = await applyCpnEventToStore(store, ev("cpn.payment.completed"));

    expect(r).toMatchObject({ status: "ignored", reason: "duplicate" });
    expect(store.advanceCpnPayment).not.toHaveBeenCalled();
  });

  it("refuses to regress out of a terminal state", async () => {
    const { store, current } = memStore(record("COMPLETED"));

    const r = await applyCpnEventToStore(store, ev("cpn.payment.cryptoFundsPending"));

    expect(r).toMatchObject({ status: "ignored", reason: "illegal" });
    expect(store.advanceCpnPayment).not.toHaveBeenCalled();
    expect(current()?.status).toBe("COMPLETED");
  });

  it("does not conjure a row for a payment it never recorded", async () => {
    const { store } = memStore(null);

    const r = await applyCpnEventToStore(store, ev("cpn.payment.completed"));

    expect(r).toMatchObject({ status: "unknown", paymentId: "pay_1" });
    expect(store.advanceCpnPayment).not.toHaveBeenCalled();
  });

  it("fails the payment on an RFI rejection — the reducer alone would drop it", async () => {
    const { store, current } = memStore(record("CRYPTO_FUNDS_PENDING"));

    const r = await applyCpnEventToStore(store, ev("cpn.rfi.rejected", "rfi"));

    expect(r).toMatchObject({ status: "advanced", to: "FAILED" });
    expect(current()?.status).toBe("FAILED");
    expect(current()?.failure_reason).toMatch(/RFI/);
  });

  it("an OPEN rfi blocks but does not move the payment", async () => {
    const { store, current } = memStore(record("CRYPTO_FUNDS_PENDING"));

    const r = await applyCpnEventToStore(store, ev("cpn.rfi.informationRequired", "rfi"));

    expect(r.status).toBe("ignored");
    expect(current()?.status).toBe("CRYPTO_FUNDS_PENDING");
  });

  it("records every event, including the ones that change nothing", async () => {
    const { store } = memStore(record("COMPLETED"));

    await applyCpnEventToStore(store, ev("cpn.payment.completed"));

    expect(store.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cpn.payment.completed", sigVerified: true }),
    );
  });
});
