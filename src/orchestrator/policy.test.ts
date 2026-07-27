import { describe, expect, it } from "vitest";
import {
  RELEASE_PROOF_KINDS,
  ReleaseRejected,
  WEDGES,
  assertReleaseProof,
  checkReleaseProof,
  expiriesFor,
  policyFor,
  timeoutPolicyFor,
} from "./policy.ts";

const NOW = 1_800_000_000;

describe("timeout per-wedge (CLAUDE.md §1)", () => {
  it("physical goods use reclaim — pro-buyer", () => {
    expect(timeoutPolicyFor("physical_demo")).toBe("reclaim");
  });

  it.each(["contractor_payout", "digital_goods", "invoice"] as const)(
    "%s memakai auto_capture — pro-seller",
    (wedge) => {
      expect(timeoutPolicyFor(wedge)).toBe("auto_capture");
    },
  );

  it("only weak-proof wedges are pro-buyer", () => {
    const reclaimWedges = WEDGES.filter((w) => timeoutPolicyFor(w) === "reclaim");
    expect(reclaimWedges).toEqual(["physical_demo"]);
  });

  it("every wedge states its rationale", () => {
    for (const w of WEDGES) expect(policyFor(w).rationale.length).toBeGreaterThan(10);
  });
});

describe("release hook — proof injected by the host", () => {
  it("accepts proof that fits the wedge", () => {
    expect(checkReleaseProof("contractor_payout", { kind: "milestone", ref: "M-42" }).accepted).toBe(true);
    expect(checkReleaseProof("digital_goods", { kind: "access_granted", ref: "LIC-1" }).accepted).toBe(true);
    expect(checkReleaseProof("physical_demo", { kind: "delivery", ref: "TRK-9" }).accepted).toBe(true);
  });

  it("rejects proof that does not fit the wedge", () => {
    // A digital-goods order released on a delivery receipt is a category error:
    // there is nothing to deliver.
    const r = checkReleaseProof("digital_goods", { kind: "delivery", ref: "TRK-9" });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/does not fit/);
  });

  it("rejects an unknown proof kind", () => {
    const r = checkReleaseProof("invoice", { kind: "vibes" as never });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/unknown proof kind/);
  });

  it("manual diterima di semua wedge tapi ditandai override", () => {
    for (const wedge of WEDGES) {
      const r = checkReleaseProof(wedge, { kind: "manual", ref: "ops-1" });
      expect(r.accepted).toBe(true);
      expect(r.manualOverride).toBe(true);
    }
  });

  it("non-manual proof is not flagged as an override", () => {
    expect(checkReleaseProof("contractor_payout", { kind: "milestone" }).manualOverride).toBe(false);
  });

  it("assertReleaseProof throws with code INVALID_RELEASE_PROOF", () => {
    try {
      assertReleaseProof("digital_goods", { kind: "delivery" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ReleaseRejected);
      expect((e as ReleaseRejected).code).toBe("INVALID_RELEASE_PROOF");
    }
  });

  it("every wedge accepts at least one non-manual proof", () => {
    // A wedge that only accepted `manual` would make the hook meaningless.
    for (const wedge of WEDGES) {
      const nonManual = policyFor(wedge).expectedProof.filter((k) => k !== "manual");
      expect(nonManual.length, `${wedge} has no non-manual proof`).toBeGreaterThan(0);
    }
  });

  it("every proof kind is used by at least one wedge", () => {
    const used = new Set(WEDGES.flatMap((w) => policyFor(w).expectedProof));
    for (const kind of RELEASE_PROOF_KINDS) expect(used.has(kind), `${kind} is unused`).toBe(true);
  });
});

describe("expiry arithmetic", () => {
  it("always satisfies the ordering the contract requires", () => {
    for (const wedge of WEDGES) {
      const e = expiriesFor(wedge, NOW);
      expect(e.preApprovalExpiry).toBeLessThanOrEqual(e.authorizationExpiry);
      expect(e.authorizationExpiry).toBeLessThanOrEqual(e.refundExpiry);
    }
  });

  it("weak-proof wedges get a shorter authorization window", () => {
    // Shorter window = buyer can reclaim sooner without the operator.
    const weak = expiriesFor("physical_demo", NOW);
    const strong = expiriesFor("digital_goods", NOW);
    expect(weak.authorizationExpiry).toBeLessThan(strong.authorizationExpiry);
  });

  it("rejects an override that breaks the ordering", () => {
    expect(() =>
      expiriesFor("invoice", NOW, { preApproval: NOW + 100, authorization: NOW + 50 }),
    ).toThrow(/Invalid expiry ordering/);

    expect(() =>
      expiriesFor("invoice", NOW, { authorization: NOW + 1000, refund: NOW + 500 }),
    ).toThrow(/Invalid expiry ordering/);
  });

  it("honours a valid override", () => {
    const e = expiriesFor("invoice", NOW, {
      preApproval: NOW + 60,
      authorization: NOW + 120,
      refund: NOW + 180,
    });
    expect(e).toEqual({
      preApprovalExpiry: NOW + 60,
      authorizationExpiry: NOW + 120,
      refundExpiry: NOW + 180,
    });
  });
});
