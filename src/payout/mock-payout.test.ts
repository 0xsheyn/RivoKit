import { describe, expect, it } from "vitest";
import { mockPayout, isMockPayout, toPayoutWire, fromPayoutWire } from "./mock-payout.ts";

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
    expect(p.disclaimer).toMatch(/does not execute the fiat leg/i);
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

describe("payout wire form (persistence)", () => {
  const huge = 9_007_199_254_740_995n;   // > Number.MAX_SAFE_INTEGER
  const p = mockPayout({ orderId: "ord_1", beneficiary: BENEFICIARY, eurcMinor: huge, now: 1 });

  it("survives a JSON round-trip that a bigint would not", () => {
    expect(() => JSON.stringify(p)).toThrow();          // the hazard this guards
    const stored = JSON.parse(JSON.stringify(toPayoutWire(p)));
    expect(fromPayoutWire(stored)).toEqual(p);
  });

  it("keeps amounts as strings on the wire, never JSON numbers", () => {
    const w = toPayoutWire(p);
    expect(typeof w.source.amountMinor).toBe("string");
    expect(typeof w.target.amountMinor).toBe("string");
    expect(w.source.amountMinor).toBe(huge.toString());
  });

  it("does not round an amount above Number.MAX_SAFE_INTEGER", () => {
    // What a JSON-number column would have done to this amount:
    expect(BigInt(Number(huge))).not.toBe(huge);
    // What the string wire form does:
    const back = fromPayoutWire(JSON.parse(JSON.stringify(toPayoutWire(p))));
    expect(back.target.amountMinor).toBe(huge);
  });

  it("carries the MOCK label through persistence — the DB constraint checks it", () => {
    expect(toPayoutWire(p).label).toBe("MOCK");
    expect(toPayoutWire(p).executed).toBe(false);
  });
});
