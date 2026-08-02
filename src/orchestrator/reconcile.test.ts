import { describe, expect, it, vi } from "vitest";
import { reconcileOrder, reconcilePending, type ReconcileDeps } from "./reconcile.ts";
import type { OrderRecord } from "./order-store.ts";
import type { PaymentState } from "../escrow/operations.ts";

const HASH = "0xabc0000000000000000000000000000000000000000000000000000000000000";

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "ord_1",
    payer: "0x1", receiver: "0x2", operator: "0x3", token: "0x4",
    price_eur: "2000000", buffer_bps: 150, usdc_amount: "2000000",
    max_amount: "2000000", salt: "1", min_fee_bps: 0, max_fee_bps: 0, fee_receiver: "0x0",
    receiving_chain: "Ethereum_Sepolia", mode: "escrow", payout_to: "wallet", wedge: "digital_goods",
    state: "funding_pending", timeout_kind: "auto_capture",
    timeout_deadline: "", pre_approval_expiry: "", authorization_expiry: "", refund_expiry: "",
    payment_info_hash: HASH, eurc_out: null, rebate: null, failure_reason: null,
    created_at: "2026-07-22T00:00:00Z", funded_at: null, settled_at: null,
    ...overrides,
  };
}

function deps(paymentState: PaymentState): ReconcileDeps & {
  transition: ReturnType<typeof vi.fn>;
} {
  const transition = vi.fn(async (_id: string, to: string) => order({ state: to as OrderRecord["state"] }));
  return {
    transition,
    store: {
      transition,
      get: vi.fn(),
      listPending: vi.fn(),
    } as unknown as ReconcileDeps["store"],
    escrow: { getPaymentState: vi.fn(async () => paymentState) },
  };
}

const held = (capturable: bigint): PaymentState => ({
  hasCollectedPayment: capturable > 0n,
  capturableAmount: capturable,
  refundableAmount: 0n,
});

describe("reconcileOrder — funding_pending", () => {
  it("promotes to funded when escrow holds the authorized amount", async () => {
    const d = deps(held(2_000_000n));
    const r = await reconcileOrder(d, order());
    expect(r.action).toBe("advanced_to_funded");
    expect(d.transition).toHaveBeenCalledWith("ord_1", "funded", expect.objectContaining({ fundedAt: expect.any(Date) }));
  });

  it("promotes when escrow holds MORE than the authorized amount", async () => {
    const d = deps(held(3_000_000n));
    expect((await reconcileOrder(d, order())).action).toBe("advanced_to_funded");
  });

  it("stays pending when escrow holds less than the authorized amount", async () => {
    const d = deps(held(0n));
    const r = await reconcileOrder(d, order());
    expect(r.action).toBe("still_funding");
    expect(d.transition).not.toHaveBeenCalled();
  });

  it("is blocked when the order has no payment_info_hash", async () => {
    const d = deps(held(2_000_000n));
    const r = await reconcileOrder(d, order({ payment_info_hash: null }));
    expect(r.action).toBe("blocked_no_hash");
    expect(d.escrow.getPaymentState).not.toHaveBeenCalled();
  });
});

describe("reconcileOrder — refund_pending", () => {
  it("never closes a refund on escrow evidence alone; asks for a bridge retry", async () => {
    const d = deps(held(0n));
    const r = await reconcileOrder(d, order({ state: "refund_pending" }));
    expect(r.action).toBe("needs_bridge_retry");
    expect(d.transition).not.toHaveBeenCalled();
    // Escrow state is irrelevant to the origin-chain leg — do not even read it.
    expect(d.escrow.getPaymentState).not.toHaveBeenCalled();
  });
});

describe("reconcileOrder — idempotence / other states", () => {
  it("skips a settled order so a repeated sweep is a no-op", async () => {
    const d = deps(held(2_000_000n));
    for (const state of ["funded", "released", "refunded"] as const) {
      const r = await reconcileOrder(d, order({ state }));
      expect(r.action).toBe("skipped");
    }
    expect(d.transition).not.toHaveBeenCalled();
  });
});

describe("reconcilePending", () => {
  it("returns one result per pending order", async () => {
    const d = deps(held(2_000_000n));
    d.store.listPending = vi.fn(async () => [
      order({ id: "a", state: "funding_pending" }),
      order({ id: "b", state: "refund_pending" }),
    ]);
    const results = await reconcilePending(d);
    expect(results.map((r) => [r.orderId, r.action])).toEqual([
      ["a", "advanced_to_funded"],
      ["b", "needs_bridge_retry"],
    ]);
  });
});
