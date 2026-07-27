/**
 * Compliance screening — a gate, run BEFORE money moves.
 *
 * PRD US-07: a host screens an address through Circle's Compliance Engine before
 * funding and before payout. The point of screening is to stop a transfer, so it
 * has to run and PASS before the transfer, not alongside it — a screen whose
 * result arrives after the funds have left has screened nothing.
 *
 * RivoKit does not own compliance (CLAUDE.md §0.7): KYB/AML and the licensed
 * fiat leg are the host's. This is the thin, honest slice RivoKit can offer —
 * an address screen wired in front of the two money-moving steps — and no more.
 * `default-deny` is the posture: anything not explicitly APPROVED blocks, so a
 * screener error or an unrecognized verdict fails closed, never open.
 *
 * The screener is injected. The module carries no HTTP client, which keeps the
 * gate logic unit-testable and lets the live path pass a Circle-backed screener.
 */

export type ScreenDecision = "APPROVED" | "DENIED" | "REVIEW";

export type ScreenResult = {
  decision: ScreenDecision;
  address: string;
  chain: string;
  reasons?: string[] | undefined;
  raw?: unknown;
};

/** Screens one address on one chain. Injected so the gate stays HTTP-free. */
export type Screener = (address: string, chain: string) => Promise<ScreenResult>;

export type ScreenContext = "funding" | "payout";

export class ComplianceBlockedError extends Error {
  readonly code = "COMPLIANCE_BLOCKED";
  readonly address: string;
  readonly decision: ScreenDecision;
  readonly context: ScreenContext;

  constructor(address: string, decision: ScreenDecision, context: ScreenContext, reasons?: string[]) {
    super(
      `Screening ${context} for ${address} did not pass (${decision})` +
        (reasons?.length ? `: ${reasons.join(", ")}` : ""),
    );
    this.name = "ComplianceBlockedError";
    this.address = address;
    this.decision = decision;
    this.context = context;
  }
}

export function createComplianceGate(screener: Screener) {
  return {
    screen: screener,

    /**
     * Screen `address` and throw ComplianceBlockedError unless APPROVED.
     * Fails closed: a screener that throws is treated as a block, not a pass.
     */
    async assertAllowed(address: string, chain: string, context: ScreenContext): Promise<ScreenResult> {
      let result: ScreenResult;
      try {
        result = await screener(address, chain);
      } catch (e) {
        throw new ComplianceBlockedError(address, "REVIEW", context, [
          `screener failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`,
        ]);
      }
      if (result.decision !== "APPROVED") {
        throw new ComplianceBlockedError(address, result.decision, context, result.reasons);
      }
      return result;
    },
  };
}

export type ComplianceGate = ReturnType<typeof createComplianceGate>;

/**
 * Map Circle's screening response to a decision. Circle returns `result` of
 * `APPROVED` or `DENIED`; anything else (review tiers, unknown) becomes REVIEW,
 * which the gate treats as a block — fail closed.
 */
export function decisionFromCircle(response: unknown): ScreenResult {
  const r = (response ?? {}) as Record<string, any>;
  const raw = r.result ?? r.decision?.result ?? r.status;
  const decision: ScreenDecision = raw === "APPROVED" ? "APPROVED" : raw === "DENIED" ? "DENIED" : "REVIEW";
  const reasons: string[] | undefined =
    r.decision?.reasons ?? r.reasons ?? (r.decision?.ruleName ? [r.decision.ruleName] : undefined);
  return {
    decision,
    address: r.address ?? "",
    chain: r.chain ?? "",
    reasons,
    raw: response,
  };
}

/**
 * Build a Circle-backed screener from an injected POST function. `post` should
 * call `POST /v1/w3s/compliance/screening/addresses` and return the parsed
 * `data`. The idempotency key must be supplied by the caller (Circle requires
 * one and it must be stable per logical screen).
 */
export function createCircleScreener(
  post: (path: string, body: unknown) => Promise<unknown>,
  idempotencyKeyFor: (address: string, chain: string) => string,
): Screener {
  return async (address, chain) => {
    const data = await post("/v1/w3s/compliance/screening/addresses", {
      idempotencyKey: idempotencyKeyFor(address, chain),
      address,
      chain,
    });
    const result = decisionFromCircle(data);
    return { ...result, address, chain };
  };
}
