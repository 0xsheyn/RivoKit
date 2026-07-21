import { describe, expect, it, vi } from "vitest";
import {
  createComplianceGate,
  createCircleScreener,
  decisionFromCircle,
  ComplianceBlockedError,
  type ScreenResult,
} from "./compliance.ts";

const approved = (address: string, chain: string): ScreenResult => ({ decision: "APPROVED", address, chain });

describe("complianceGate.assertAllowed", () => {
  it("passes an APPROVED address through and returns the result", async () => {
    const gate = createComplianceGate(async (a, c) => approved(a, c));
    const r = await gate.assertAllowed("0x1", "ARC", "funding");
    expect(r.decision).toBe("APPROVED");
  });

  it("blocks a DENIED address with COMPLIANCE_BLOCKED", async () => {
    const gate = createComplianceGate(async (a, c) => ({ decision: "DENIED", address: a, chain: c, reasons: ["sanctions"] }));
    await expect(gate.assertAllowed("0x1", "ARC", "payout")).rejects.toMatchObject({
      code: "COMPLIANCE_BLOCKED",
      decision: "DENIED",
      context: "payout",
    });
  });

  it("blocks a REVIEW verdict — anything but APPROVED fails closed", async () => {
    const gate = createComplianceGate(async (a, c) => ({ decision: "REVIEW", address: a, chain: c }));
    await expect(gate.assertAllowed("0x1", "ARC", "funding")).rejects.toBeInstanceOf(ComplianceBlockedError);
  });

  it("fails closed when the screener itself throws", async () => {
    const gate = createComplianceGate(async () => {
      throw new Error("network down");
    });
    await expect(gate.assertAllowed("0x1", "ARC", "funding")).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
  });
});

describe("decisionFromCircle", () => {
  it("maps APPROVED and DENIED verbatim", () => {
    expect(decisionFromCircle({ result: "APPROVED" }).decision).toBe("APPROVED");
    expect(decisionFromCircle({ result: "DENIED" }).decision).toBe("DENIED");
  });

  it("maps unknown / review tiers to REVIEW (fail closed)", () => {
    expect(decisionFromCircle({ result: "MANUAL_REVIEW" }).decision).toBe("REVIEW");
    expect(decisionFromCircle({}).decision).toBe("REVIEW");
  });

  it("surfaces a rule name as a reason", () => {
    expect(decisionFromCircle({ result: "DENIED", decision: { ruleName: "OFAC" } }).reasons).toEqual(["OFAC"]);
  });
});

describe("createCircleScreener", () => {
  it("posts to the screening endpoint and maps the response", async () => {
    const post = vi.fn(async () => ({ result: "APPROVED" }));
    const screener = createCircleScreener(post, (a, c) => `${a}:${c}`);
    const r = await screener("0xabc", "ARC");
    expect(post).toHaveBeenCalledWith("/v1/w3s/compliance/screening/addresses", {
      idempotencyKey: "0xabc:ARC",
      address: "0xabc",
      chain: "ARC",
    });
    expect(r).toMatchObject({ decision: "APPROVED", address: "0xabc", chain: "ARC" });
  });
});
