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
  it("barang fisik memakai reclaim — pro-buyer", () => {
    expect(timeoutPolicyFor("physical_demo")).toBe("reclaim");
  });

  it.each(["contractor_payout", "digital_goods", "invoice"] as const)(
    "%s memakai auto_capture — pro-seller",
    (wedge) => {
      expect(timeoutPolicyFor(wedge)).toBe("auto_capture");
    },
  );

  it("hanya wedge bukti-lemah yang pro-buyer", () => {
    const reclaimWedges = WEDGES.filter((w) => timeoutPolicyFor(w) === "reclaim");
    expect(reclaimWedges).toEqual(["physical_demo"]);
  });

  it("setiap wedge punya alasan tertulis", () => {
    for (const w of WEDGES) expect(policyFor(w).rationale.length).toBeGreaterThan(10);
  });
});

describe("release hook — bukti disuntik host", () => {
  it("menerima bukti yang cocok dengan wedge", () => {
    expect(checkReleaseProof("contractor_payout", { kind: "milestone", ref: "M-42" }).accepted).toBe(true);
    expect(checkReleaseProof("digital_goods", { kind: "access_granted", ref: "LIC-1" }).accepted).toBe(true);
    expect(checkReleaseProof("physical_demo", { kind: "delivery", ref: "TRK-9" }).accepted).toBe(true);
  });

  it("menolak bukti yang tidak cocok dengan wedge", () => {
    // A digital-goods order released on a delivery receipt is a category error:
    // there is nothing to deliver.
    const r = checkReleaseProof("digital_goods", { kind: "delivery", ref: "TRK-9" });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/tidak cocok/);
  });

  it("menolak jenis bukti yang tidak dikenal", () => {
    const r = checkReleaseProof("invoice", { kind: "vibes" as never });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/tidak dikenal/);
  });

  it("manual diterima di semua wedge tapi ditandai override", () => {
    for (const wedge of WEDGES) {
      const r = checkReleaseProof(wedge, { kind: "manual", ref: "ops-1" });
      expect(r.accepted).toBe(true);
      expect(r.manualOverride).toBe(true);
    }
  });

  it("bukti non-manual tidak ditandai override", () => {
    expect(checkReleaseProof("contractor_payout", { kind: "milestone" }).manualOverride).toBe(false);
  });

  it("assertReleaseProof melempar dengan kode INVALID_RELEASE_PROOF", () => {
    try {
      assertReleaseProof("digital_goods", { kind: "delivery" });
      throw new Error("seharusnya melempar");
    } catch (e) {
      expect(e).toBeInstanceOf(ReleaseRejected);
      expect((e as ReleaseRejected).code).toBe("INVALID_RELEASE_PROOF");
    }
  });

  it("setiap wedge menerima setidaknya satu bukti non-manual", () => {
    // A wedge that only accepted `manual` would make the hook meaningless.
    for (const wedge of WEDGES) {
      const nonManual = policyFor(wedge).expectedProof.filter((k) => k !== "manual");
      expect(nonManual.length, `${wedge} tidak punya bukti non-manual`).toBeGreaterThan(0);
    }
  });

  it("setiap jenis bukti terpakai oleh setidaknya satu wedge", () => {
    const used = new Set(WEDGES.flatMap((w) => policyFor(w).expectedProof));
    for (const kind of RELEASE_PROOF_KINDS) expect(used.has(kind), `${kind} tak terpakai`).toBe(true);
  });
});

describe("perhitungan expiry", () => {
  it("selalu memenuhi urutan yang diwajibkan kontrak", () => {
    for (const wedge of WEDGES) {
      const e = expiriesFor(wedge, NOW);
      expect(e.preApprovalExpiry).toBeLessThanOrEqual(e.authorizationExpiry);
      expect(e.authorizationExpiry).toBeLessThanOrEqual(e.refundExpiry);
    }
  });

  it("wedge bukti-lemah punya window authorization lebih pendek", () => {
    // Shorter window = buyer can reclaim sooner without the operator.
    const weak = expiriesFor("physical_demo", NOW);
    const strong = expiriesFor("digital_goods", NOW);
    expect(weak.authorizationExpiry).toBeLessThan(strong.authorizationExpiry);
  });

  it("menolak override yang melanggar urutan", () => {
    expect(() =>
      expiriesFor("invoice", NOW, { preApproval: NOW + 100, authorization: NOW + 50 }),
    ).toThrow(/Urutan expiry tidak sah/);

    expect(() =>
      expiriesFor("invoice", NOW, { authorization: NOW + 1000, refund: NOW + 500 }),
    ).toThrow(/Urutan expiry tidak sah/);
  });

  it("menghormati override yang sah", () => {
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
