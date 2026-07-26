/**
 * Release hooks and per-wedge timeout policy.
 *
 * RivoKit does NOT decide when funds are released — it cannot. It has no way to
 * observe whether a contractor finished, whether a licence key reached the
 * buyer, or whether a parcel arrived. The host owns that judgement, and calls
 * `release()` when its own business logic is satisfied (INTEGRATION.md §5).
 *
 * What RivoKit owns is the consequence of the host staying silent. Every
 * authorization expires, and the expiry has to favour someone. That choice
 * follows the strength of the available proof, per CLAUDE.md §1:
 *
 *   strong proof (B2B, digital)  → auto_capture, seller-favouring
 *   weak proof   (physical)      → reclaim,      buyer-favouring
 *
 * The asymmetry is deliberate. When nobody can prove delivery, the default must
 * not be "pay the seller anyway".
 */

export const WEDGES = [
  "contractor_payout",
  "digital_goods",
  "invoice",
  "physical_demo",
] as const;

export type Wedge = (typeof WEDGES)[number];

export const RELEASE_PROOF_KINDS = [
  "milestone",
  "access_granted",
  "delivery",
  "manual",
] as const;

export type ReleaseProofKind = (typeof RELEASE_PROOF_KINDS)[number];

export type ReleaseProof = {
  kind: ReleaseProofKind;
  /** Host's own identifier — invoice no., licence key, tracking code. */
  ref?: string;
};

export type TimeoutKind = "reclaim" | "auto_capture";

type WedgePolicy = {
  /** What happens if the host never calls release. */
  timeout: TimeoutKind;
  /** Proof kinds that fit this wedge's fulfilment model. */
  expectedProof: readonly ReleaseProofKind[];
  /** Why this wedge is treated as strong or weak proof. */
  rationale: string;
};

const POLICY: Record<Wedge, WedgePolicy> = {
  // Milestone approval is an explicit act by the paying party.
  contractor_payout: {
    timeout: "auto_capture",
    expectedProof: ["milestone", "manual"],
    rationale: "a milestone approved by the payer — strong proof",
  },

  // Access grants are deterministic and observable by the host.
  digital_goods: {
    timeout: "auto_capture",
    expectedProof: ["access_granted", "manual"],
    rationale: "deterministic access grant — strong proof",
  },

  invoice: {
    timeout: "auto_capture",
    expectedProof: ["milestone", "manual"],
    rationale: "B2B invoice acceptance — strong proof",
  },

  // The oracle problem: nothing on-chain can confirm a physical parcel matched
  // its description. Carrier APIs are trusted input, not proof (PRD §18 R6).
  physical_demo: {
    timeout: "reclaim",
    expectedProof: ["delivery", "manual"],
    rationale: "physical delivery cannot be proven on-chain — weak proof",
  },
};

export function timeoutPolicyFor(wedge: Wedge): TimeoutKind {
  return POLICY[wedge].timeout;
}

export function policyFor(wedge: Wedge): WedgePolicy {
  return POLICY[wedge];
}

export class ReleaseRejected extends Error {
  readonly code = "INVALID_RELEASE_PROOF";
  readonly wedge: Wedge;
  readonly proof: ReleaseProof;

  constructor(wedge: Wedge, proof: ReleaseProof, reason: string) {
    super(`Release rejected for wedge ${wedge}: ${reason}`);
    this.name = "ReleaseRejected";
    this.wedge = wedge;
    this.proof = proof;
  }
}

export type ReleaseCheck = {
  accepted: boolean;
  /** True when the host used `manual`, bypassing the wedge's usual proof. */
  manualOverride: boolean;
  reason?: string;
};

/**
 * Check a host-supplied release proof against the wedge.
 *
 * This is a consistency check, not verification. RivoKit cannot confirm that a
 * milestone really was approved — only that the host claimed a proof kind that
 * makes sense for this wedge. Anything stronger would be a claim RivoKit is not
 * entitled to make (LIMITATIONS.md).
 */
export function checkReleaseProof(wedge: Wedge, proof: ReleaseProof): ReleaseCheck {
  const policy = POLICY[wedge];

  if (!RELEASE_PROOF_KINDS.includes(proof.kind)) {
    return { accepted: false, manualOverride: false, reason: `unknown proof kind: ${proof.kind}` };
  }

  if (!policy.expectedProof.includes(proof.kind)) {
    return {
      accepted: false,
      manualOverride: false,
      reason:
        `proof "${proof.kind}" does not fit this wedge; ` +
        `expected: ${policy.expectedProof.join(" or ")}`,
    };
  }

  // `manual` is allowed everywhere as an escape hatch, but it is recorded as an
  // override so it shows up in the audit trail rather than passing silently.
  if (proof.kind === "manual") {
    return {
      accepted: true,
      manualOverride: true,
      reason: "rilis manual oleh host — dicatat sebagai override",
    };
  }

  return { accepted: true, manualOverride: false };
}

export function assertReleaseProof(wedge: Wedge, proof: ReleaseProof): ReleaseCheck {
  const result = checkReleaseProof(wedge, proof);
  if (!result.accepted) throw new ReleaseRejected(wedge, proof, result.reason ?? "ditolak");
  return result;
}

/**
 * Contract expiries derived from the wedge, in seconds since epoch.
 *
 * The escrow enforces preApproval <= authorization <= refund, so these are
 * produced together rather than assembled by callers.
 */
export function expiriesFor(
  wedge: Wedge,
  now: number,
  overrides: Partial<{ preApproval: number; authorization: number; refund: number }> = {},
): { preApprovalExpiry: number; authorizationExpiry: number; refundExpiry: number } {
  // Weak proof gets a SHORTER authorization window: the sooner it lapses, the
  // sooner a buyer can reclaim without needing the operator.
  const authorizationWindow =
    POLICY[wedge].timeout === "reclaim" ? 7 * 86_400 : 30 * 86_400;

  const preApprovalExpiry = overrides.preApproval ?? now + 3_600;
  const authorizationExpiry = overrides.authorization ?? now + authorizationWindow;
  const refundExpiry = overrides.refund ?? authorizationExpiry + 30 * 86_400;

  if (preApprovalExpiry > authorizationExpiry || authorizationExpiry > refundExpiry) {
    throw new Error(
      `Invalid expiry ordering: preApproval=${preApprovalExpiry} ` +
        `authorization=${authorizationExpiry} refund=${refundExpiry}. ` +
        "Kontrak mensyaratkan preApproval <= authorization <= refund.",
    );
  }

  return { preApprovalExpiry, authorizationExpiry, refundExpiry };
}
