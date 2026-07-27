/**
 * Cross-chain USDC movement.
 *
 * Two mechanisms, and the difference matters operationally:
 *
 *   bridge   burn on the source chain, attest, mint on the destination.
 *            Minutes, not seconds — CCTP attestation is off-chain and
 *            centralised. Anything built on it must survive being interrupted.
 *
 *   unified  Circle Gateway holds a chain-abstracted balance that can be spent
 *   balance  directly onto another chain. Faster, but the funds must be
 *            deposited into Gateway first.
 *
 * RivoKit uses unified balance where a payer already has one, and falls back to
 * bridging otherwise (PRD §M2). Refunds always bridge back to the order's
 * recorded `receivingChain` — invariant 5, PRD §10.
 */
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { toDecimalString } from "../settlement-fx/units.ts";

export type BridgeAdapter = unknown;

export type BridgeParams = {
  fromAdapter: BridgeAdapter;
  fromChain: BridgeChain;
  toAdapter: BridgeAdapter;
  toChain: BridgeChain;
  amountMinor: bigint;
  /**
   * Optional. CCTP bridging needs no kit key — App Kit's BridgeConfig has no
   * such field (swap does). Leaving it out lets a browser adapter bridge with
   * the payer's own wallet without shipping a server secret to the client.
   */
  kitKey?: string;
};

export type BridgeEstimate = {
  token: string;
  amount: string;
  sourceChain: string;
  destinationChain: string;
  /** Gas is charged on the SOURCE chain in ITS native token, not in USDC. */
  gasFees: ReadonlyArray<{ name: string; token: string; blockchain: string }>;
  raw: unknown;
};

export type BridgeStep = {
  name: string;
  state: string;
  txHash?: string | undefined;
  /** Present when `state === "error"` — the SDK's human-readable reason. */
  errorMessage?: string | undefined;
  /** Machine-readable classification, preferred over string-matching. */
  errorCategory?: string | undefined;
};

export type BridgeResult = {
  /** App Kit reports `state`, not `status`. */
  state: string;
  /** Per-stage detail: approve, burn, fetchAttestation, mint. */
  steps: BridgeStep[];
  /** Burn on the source chain — proof the funds left. */
  burnTxHash?: string | undefined;
  /** Mint on the destination — proof they arrived. */
  mintTxHash?: string | undefined;
  raw: unknown;
};

export class BridgeStuckError extends Error {
  readonly code = "FUNDING_STUCK";
  // Assigned in the body, not as a parameter property: Node runs .ts in
  // strip-only mode and rejects `constructor(readonly x: T)`.
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "BridgeStuckError";
    this.detail = detail;
  }
}

/**
 * The bridge came back `state: "error"` with the funds still on the source
 * chain — nothing moved, so a clean retry is safe once the cause is fixed.
 *
 * Distinct from BridgeStuckError, where the burn already happened and money is
 * in flight; conflating the two would either strand funds or double-spend them.
 */
export class BridgeFailedError extends Error {
  readonly code = "FUNDING_FAILED";
  readonly detail: unknown;
  /** True when the failure looks like the SDK could not reach a Circle host. */
  readonly networkSuspected: boolean;

  constructor(message: string, opts: { detail?: unknown; networkSuspected?: boolean } = {}) {
    super(message);
    this.name = "BridgeFailedError";
    this.detail = opts.detail;
    this.networkSuspected = opts.networkSuspected ?? false;
  }
}

/**
 * A bridge step can fail because the SDK could not reach Circle's fee/attestation
 * API rather than because a chain reverted. On this network that has meant an
 * ISP hijacking Circle's DNS — observed live on at least one network. The signal
 * is a transport error, not a revert: retries exhausted, a failed fetch, or a
 * name-resolution code.
 */
function looksLikeNetworkFailure(text: string): boolean {
  return /fetch failed|maximum retry attempts|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|CERT_HAS_EXPIRED|socket hang up/i.test(
    text,
  );
}

function mapSteps(r: Record<string, any>): BridgeStep[] {
  return (r.steps ?? []).map((s: Record<string, any>) => ({
    name: s.name,
    state: s.state,
    txHash: s.txHash ?? s.data?.txHash,
    errorMessage: s.errorMessage ?? (s.error ? String(s.error?.message ?? s.error) : undefined),
    errorCategory: s.errorCategory,
  }));
}

/**
 * Turn a raw kit bridge/retry result into a BridgeResult, throwing on anything
 * that is not a completed transfer. Shared by `execute` and `retry` so both
 * classify identically — a bridge that stalled after burn is a BridgeStuckError
 * (resume, never resend); one that never moved is a BridgeFailedError.
 */
function interpret(res: unknown): BridgeResult {
  const r = res as Record<string, any>;
  const steps = mapSteps(r);
  const burnDone = steps.some((s) => s.name === "burn" && s.state === "success");

  if (r.state !== "success") {
    const bad = steps.find((s) => s.state === "error");
    const reason = bad
      ? `step "${bad.name}" failed${bad.errorCategory ? ` (${bad.errorCategory})` : ""}: ${bad.errorMessage ?? "no message"}`
      : `bridge ended in state "${r.state}" with no successful step`;
    const network = looksLikeNetworkFailure(`${reason} ${JSON.stringify(steps)}`);

    // Burn already landed → funds are in flight; carry the result as `detail`
    // so a caller can hand it to `retry` and resume from attestation.
    if (burnDone || r.state === "pending") {
      throw new BridgeStuckError(
        `Bridge did not finish (${reason}). The funds may already be burned on the source chain — ` +
          "DO NOT resend; resume through retry (kit.retryBridge).",
        res,
      );
    }
    throw new BridgeFailedError(
      `Bridge failed without moving funds: ${reason}.` +
        (network
          ? " This is a network error (the SDK could not reach Circle's API) — " +
            "check DNS for *.circle.com (see the hijacked-DNS note), not an on-chain revert."
          : ""),
      { detail: res, networkSuspected: network },
    );
  }

  return {
    state: r.state,
    steps,
    burnTxHash: steps.find((s) => s.name === "burn")?.txHash,
    mintTxHash: steps.find((s) => s.name === "mint")?.txHash,
    raw: res,
  };
}

/**
 * Classify a THROWN error from kit.bridge / kit.retryBridge. Always throws
 * (return type `never`), so callers use it as the whole catch body.
 */
function classifyThrow(e: unknown): never {
  // Our own classified errors pass straight through.
  if (e instanceof BridgeStuckError || e instanceof BridgeFailedError) throw e;

  const msg = String((e as Error)?.message ?? e);
  // Attestation problems are recoverable and must not be reported as a failed
  // payment — the burn may already have happened, so funds are in flight.
  if (/attestation|timeout|pending/i.test(msg)) {
    throw new BridgeStuckError(
      `Bridge did not finish: ${msg.slice(0, 160)}. ` +
        "The funds may already be burned on the source chain and waiting on attestation — " +
        "DO NOT resend; resume through retry (kit.retryBridge).",
      e,
    );
  }
  // A transport failure before any burn — nothing moved, safe to retry cleanly.
  if (looksLikeNetworkFailure(msg)) {
    throw new BridgeFailedError(
      `Bridge failed — the SDK could not reach Circle's API: ${msg.slice(0, 160)}. ` +
        "Check DNS for *.circle.com (see the hijacked-DNS note), not an on-chain revert.",
      { detail: e, networkSuspected: true },
    );
  }
  throw e;
}

function bridgeArgs(params: BridgeParams) {
  return {
    from: { adapter: params.fromAdapter, chain: params.fromChain },
    to: { adapter: params.toAdapter, chain: params.toChain },
    amount: toDecimalString(params.amountMinor),
    config: params.kitKey ? { kitKey: params.kitKey } : {},
  };
}

export function createBridge(kit: AppKit = new AppKit()) {
  return {
    /**
     * Quote a bridge without moving anything.
     *
     * Note the destination is expressed as `{ adapter, chain }`, not
     * `{ chain, recipientAddress }`. The docs' `spend` example uses the latter
     * shape and it is rejected here — a mismatch worth remembering, since the
     * error ("to: Invalid input") does not say which field is wrong.
     */
    async estimate(params: BridgeParams): Promise<BridgeEstimate> {
      const est = await kit.estimateBridge({
        from: { adapter: params.fromAdapter, chain: params.fromChain },
        to: { adapter: params.toAdapter, chain: params.toChain },
        amount: toDecimalString(params.amountMinor),
        config: params.kitKey ? { kitKey: params.kitKey } : {},
      } as never);

      const e = est as Record<string, any>;
      return {
        token: e.token,
        amount: e.amount,
        sourceChain: e.source?.chain,
        destinationChain: e.destination?.chain,
        gasFees: e.gasFees ?? [],
        raw: est,
      };
    },

    /**
     * Execute. Resolves once the SDK considers the transfer done, which for
     * CCTP means burn, attestation, and mint have all completed.
     *
     * Expect this to take minutes and to be interrupted. Callers should record
     * the order as pending BEFORE calling, so a crash mid-flight leaves a trail
     * rather than a payment nobody knows about.
     */
    async execute(params: BridgeParams): Promise<BridgeResult> {
      // There is no top-level txHash: a CCTP transfer is four stages across two
      // chains, so `interpret` reads the per-step hashes (burn proves funds
      // left, mint proves they arrived) and throws on any non-completed state.
      try {
        return interpret(await kit.bridge(bridgeArgs(params) as never));
      } catch (e) {
        return classifyThrow(e);
      }
    },

    /**
     * Resume an interrupted bridge instead of starting a second one.
     *
     * `kit.retryBridge` picks up from the attestation/mint stage using `previous`
     * (the result carried on a BridgeStuckError) — it does NOT burn again, so it
     * is the ONLY safe way to continue a stuck transfer. Re-running `execute`
     * would move a second amount. If it is still stuck it throws BridgeStuckError
     * again; nothing is ever double-sent.
     */
    async retry(params: BridgeParams, previous: unknown): Promise<BridgeResult> {
      try {
        return interpret(await kit.retryBridge(bridgeArgs(params) as never, previous as never));
      } catch (e) {
        return classifyThrow(e);
      }
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;
