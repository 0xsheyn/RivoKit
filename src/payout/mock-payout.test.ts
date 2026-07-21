import { describe, expect, it } from "vitest";
import { mockPayout, isMockPayout } from "./mock-payout.ts";

const BENEFICIARY = "0xbd2B9A6a52423e419a954D2BBA2729d2562382E5";

describe("mockPayout", () => {
  const p = mockPayout({ orderId: "ord_1", beneficiary: BENEFICIARY, eurcMinor: 1_930_000n, now: 1_700_000_000 });

  it("is unmistakably a mock: kind, label, and executed all say so", () => {
    expect(p.kind).toBe("mock");
    expect(p.label).toBe("MOCK");
    expect(p.executed).toBe(false);
    expect(isMockPayout(p)).toBe(true);
  });

  it("carries a disclaimer that names the boundary", () => {
    expect(p.disclaimer).toMatch(/MOCK/);
    expect(p.disclaimer).toMatch(/tidak mengeksekusi leg fiat/i);
    expect(p.disclaimer).toMatch(/host/i);
  });

  it("delivers on-chain EURC and instructs a 1:1 nominal EUR payout, flagged estimated", () => {
    expect(p.source).toMatchObject({ currency: "EURC", chain: "Arc_Testnet", amountMinor: 1_930_000n });
    expect(p.target).toMatchObject({ currency: "EUR", amountMinor: 1_930_000n, estimated: true });
  });

  it("keeps money as bigint minor units, never float", () => {
    expect(typeof p.source.amountMinor).toBe("bigint");
    expect(typeof p.target.amountMinor).toBe("bigint");
  });

  it("passes through the settlement tx hash when given", () => {
    const withTx = mockPayout({ orderId: "o", beneficiary: BENEFICIARY, eurcMinor: 1n, settlementTxHash: "0xabc", now: 1 });
    expect(withTx.source.settlementTxHash).toBe("0xabc");
  });

  it("refuses a non-positive payout — there is nothing to pay", () => {
    expect(() => mockPayout({ orderId: "o", beneficiary: BENEFICIARY, eurcMinor: 0n, now: 1 })).toThrow(/> 0/);
    expect(() => mockPayout({ orderId: "o", beneficiary: BENEFICIARY, eurcMinor: -5n, now: 1 })).toThrow();
  });
});
