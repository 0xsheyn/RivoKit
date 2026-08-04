import { describe, expect, it, vi } from "vitest";
import { reconcileCpnPayment, reconcileCpnPayments } from "./cpn-reconcile.ts";
import { reconcilePaymentStatus } from "./cpn-state.ts";
import type { CpnPaymentRecord } from "../orchestrator/order-store.ts";
import type { CpnPaymentState } from "./cpn-state.ts";

function mkRow(o: Partial<CpnPaymentRecord> = {}): CpnPaymentRecord {
  return {
    payment_id: "pay_1", order_id: null, corridor: "EUR/SEPA",
    sender_address: "0x1111111111111111111111111111111111111111",
    signed_by: "wallet",
    source_minor: "12000000", source_currency: "USDC",
    destination_minor: "1031", destination_currency: "EUR", destination_scale: 2,
    status: "CRYPTO_FUNDS_PENDING", transaction_id: null, failure_reason: null,
    created_at: "2026-08-04T00:00:00Z", updated_at: "2026-08-04T00:00:00Z",
    ...o,
  };
}

function mkDeps(over: { rows?: CpnPaymentRecord[]; status?: unknown } = {}) {
  const store = {
    listCpnPayments: vi.fn(async () => over.rows ?? []),
    advanceCpnPayment: vi.fn(async (id: string, s: CpnPaymentState) => mkRow({ payment_id: id, status: s })),
    recordEvent: vi.fn(async () => {}),
  };
  const ramp = {
    status: over.status ?? vi.fn(async () => ({ status: "COMPLETED" })),
  };
  return { store, ramp } as never as {
    store: typeof store;
    ramp: { status: ReturnType<typeof vi.fn> };
  };
}

/**
 * The gap this closes: a standalone cash-out is moved by webhooks and by
 * nothing else. When the endpoint is down — and the one this repo proved
 * against was a quick tunnel that dies with its process — the row stays wrong
 * forever.
 */
describe("reconcilePaymentStatus — a poll is not a webhook", () => {
  it("accepts a forward JUMP that a single event could not make", () => {
    // The webhook reducer refuses this: no single event crosses two edges.
    // A poll reporting it is not a violation, it is the missed notifications.
    expect(reconcilePaymentStatus("CREATED", "COMPLETED")).toEqual({
      state: "COMPLETED", changed: true,
    });
  });

  it("refuses to go backwards", () => {
    expect(reconcilePaymentStatus("FIAT_PAYMENT_INITIATED", "CRYPTO_FUNDS_PENDING")).toMatchObject({
      changed: false, reason: "illegal", state: "FIAT_PAYMENT_INITIATED",
    });
  });

  it("refuses to leave a terminal state, however stale the read", () => {
    expect(reconcilePaymentStatus("COMPLETED", "CRYPTO_FUNDS_PENDING")).toMatchObject({
      changed: false, reason: "illegal",
    });
    expect(reconcilePaymentStatus("FAILED", "COMPLETED")).toMatchObject({
      changed: false, reason: "illegal",
    });
  });

  it("treats agreement as a no-op, not a write", () => {
    expect(reconcilePaymentStatus("CRYPTO_FUNDS_PENDING", "CRYPTO_FUNDS_PENDING")).toMatchObject({
      changed: false, reason: "duplicate",
    });
  });

  it("ignores a status CPN has never documented", () => {
    // `CpnPaymentStatus` is `string & {}` — the rail can return anything.
    expect(reconcilePaymentStatus("CREATED", "SOMETHING_NEW")).toMatchObject({
      changed: false, reason: "not-payment",
    });
  });

  it("reaches FAILED from every live state", () => {
    for (const s of ["CREATED", "CRYPTO_FUNDS_PENDING", "FIAT_PAYMENT_INITIATED"] as const) {
      expect(reconcilePaymentStatus(s, "FAILED")).toEqual({ state: "FAILED", changed: true });
    }
  });
});

describe("reconcileCpnPayment", () => {
  it("advances a stale row and records the poll as UNVERIFIED", async () => {
    const deps = mkDeps();
    const result = await reconcileCpnPayment(deps, mkRow());

    expect(result).toMatchObject({
      paymentId: "pay_1", from: "CRYPTO_FUNDS_PENDING", to: "COMPLETED", action: "advanced",
    });
    expect(deps.store.advanceCpnPayment).toHaveBeenCalledWith("pay_1", "COMPLETED");
    // This state came from a poll we made, not a message Circle signed. Claiming
    // verification it never had would be worse than not recording it.
    expect(deps.store.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cpn.reconcile.advanced", sigVerified: false }),
    );
  });

  it("writes nothing when the rail agrees", async () => {
    const deps = mkDeps({ status: vi.fn(async () => ({ status: "CRYPTO_FUNDS_PENDING" })) });
    const result = await reconcileCpnPayment(deps, mkRow());

    expect(result.action).toBe("unchanged");
    expect(deps.store.advanceCpnPayment).not.toHaveBeenCalled();
    expect(deps.store.recordEvent).not.toHaveBeenCalled();
  });

  it("never re-reads a row that is already terminal", async () => {
    const deps = mkDeps();
    const result = await reconcileCpnPayment(deps, mkRow({ status: "COMPLETED" }));

    expect(result).toMatchObject({ action: "ignored", detail: "already terminal" });
    // The saved API call is the point: a terminal row can never move again.
    expect(deps.ramp.status).not.toHaveBeenCalled();
  });

  it("reports an unreachable rail instead of throwing", async () => {
    const deps = mkDeps({
      status: vi.fn(async () => { throw new Error("429 rate limited"); }),
    });
    const result = await reconcileCpnPayment(deps, mkRow());

    expect(result).toMatchObject({ action: "unreachable", from: "CRYPTO_FUNDS_PENDING", to: "CRYPTO_FUNDS_PENDING" });
    expect(result.detail).toMatch(/rate limited/);
    expect(deps.store.advanceCpnPayment).not.toHaveBeenCalled();
  });
});

describe("reconcileCpnPayments — the sweep", () => {
  it("visits only the non-terminal rows", async () => {
    const deps = mkDeps({
      rows: [
        mkRow({ payment_id: "a", status: "CRYPTO_FUNDS_PENDING" }),
        mkRow({ payment_id: "b", status: "COMPLETED" }),
        mkRow({ payment_id: "c", status: "FAILED" }),
        mkRow({ payment_id: "d", status: "CREATED" }),
      ],
    });

    const results = await reconcileCpnPayments(deps);

    expect(results.map((r) => r.paymentId)).toEqual(["a", "d"]);
    expect(deps.ramp.status).toHaveBeenCalledTimes(2);
  });

  it("one unreachable row does not abandon the rest", async () => {
    const status = vi.fn(async (id: string) => {
      if (id === "a") throw new Error("boom");
      return { status: "COMPLETED" };
    });
    const deps = mkDeps({
      rows: [mkRow({ payment_id: "a" }), mkRow({ payment_id: "b" })],
      status,
    });

    const results = await reconcileCpnPayments(deps);

    expect(results.map((r) => r.action)).toEqual(["unreachable", "advanced"]);
  });

  it("is safe to run twice — the second pass writes nothing", async () => {
    const rows = [mkRow({ payment_id: "a" })];
    const deps = mkDeps({ rows });

    await reconcileCpnPayments(deps);
    // Second pass sees what the first one wrote.
    rows[0] = mkRow({ payment_id: "a", status: "COMPLETED" });
    const second = await reconcileCpnPayments(deps);

    expect(second).toEqual([]);
    expect(deps.store.advanceCpnPayment).toHaveBeenCalledTimes(1);
  });
});
