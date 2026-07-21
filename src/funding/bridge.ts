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
  kitKey: string;
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
 * ISP hijacking Circle's DNS — see the `dns-api-circle-dibajak` note. The signal
 * is a transport error, not a revert: retries exhausted, a failed fetch, or a
 * name-resolution code.
 */
function looksLikeNetworkFailure(text: string): boolean {
  return /fetch failed|maximum retry attempts|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|CERT_HAS_EXPIRED|socket hang up/i.test(
    text,
  );
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
        config: { kitKey: params.kitKey },
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
      try {
        const res = await kit.bridge({
          from: { adapter: params.fromAdapter, chain: params.fromChain },
          to: { adapter: params.toAdapter, chain: params.toChain },
          amount: toDecimalString(params.amountMinor),
          config: { kitKey: params.kitKey },
        } as never);

        const r = res as Record<string, any>;
        // There is no top-level txHash: a CCTP transfer is four stages across
        // two chains, so the hashes live per-step. Burn and mint are the two
        // that matter — burn proves the funds left, mint proves they arrived.
        const steps: BridgeStep[] = (r.steps ?? []).map((s: Record<string, any>) => ({
          name: s.name,
          state: s.state,
          txHash: s.txHash ?? s.data?.txHash,
          errorMessage: s.errorMessage ?? (s.error ? String(s.error?.message ?? s.error) : undefined),
          errorCategory: s.errorCategory,
        }));

        const burnDone = steps.some((s) => s.name === "burn" && s.state === "success");

        // App Kit reports a failed bridge as `state: "error"` WITHOUT throwing.
        // Returning it as if it were a normal result lets a non-transfer look
        // like a completed one downstream — exactly what stranded an order in
        // funding_pending with no money moved. Turn it into a thrown error.
        if (r.state !== "success") {
          const bad = steps.find((s) => s.state === "error");
          const reason = bad
            ? `langkah "${bad.name}" gagal${bad.errorCategory ? ` (${bad.errorCategory})` : ""}: ${bad.errorMessage ?? "tanpa pesan"}`
            : `bridge berakhir state "${r.state}" tanpa langkah sukses`;
          const network = looksLikeNetworkFailure(`${reason} ${JSON.stringify(steps)}`);

          // Burn already landed → funds are in flight, must be resumed not
          // resent, regardless of what the later step reported.
          if (burnDone || r.state === "pending") {
            throw new BridgeStuckError(
              `Bridge belum tuntas (${reason}). Dana mungkin sudah ter-burn di chain asal — ` +
                "JANGAN kirim ulang; lanjutkan lewat retryBridge.",
              res,
            );
          }
          throw new BridgeFailedError(
            `Bridge gagal tanpa memindahkan dana: ${reason}.` +
              (network
                ? " Ini galat jaringan (SDK tak bisa menjangkau API Circle) — " +
                  "cek DNS host *.circle.com (lihat catatan DNS dibajak), bukan revert on-chain."
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
      } catch (e) {
        // Our own classified errors (thrown above) pass straight through.
        if (e instanceof BridgeStuckError || e instanceof BridgeFailedError) throw e;

        const msg = String((e as Error)?.message ?? e);
        // Attestation problems are recoverable and must not be reported as a
        // failed payment — the burn may already have happened on the source
        // chain, in which case the funds are in flight, not lost.
        if (/attestation|timeout|pending/i.test(msg)) {
          throw new BridgeStuckError(
            `Bridge belum tuntas: ${msg.slice(0, 160)}. ` +
              "Dana mungkin sudah ter-burn di chain asal dan sedang menunggu atestasi — " +
              "JANGAN kirim ulang; lanjutkan lewat retryBridge.",
            e,
          );
        }
        // A transport failure before any burn — nothing moved, safe to retry.
        if (looksLikeNetworkFailure(msg)) {
          throw new BridgeFailedError(
            `Bridge gagal — SDK tak bisa menjangkau API Circle: ${msg.slice(0, 160)}. ` +
              "Cek DNS host *.circle.com (lihat catatan DNS dibajak), bukan revert on-chain.",
            { detail: e, networkSuspected: true },
          );
        }
        throw e;
      }
    },

    /**
     * Resume an interrupted bridge instead of starting a second one.
     *
     * Takes the original bridge arguments plus the prior result, so the SDK can
     * pick up from whichever stage completed rather than burning again.
     */
    retry: (args: unknown, previous: unknown) =>
      kit.retryBridge(args as never, previous as never),
  };
}

export type Bridge = ReturnType<typeof createBridge>;
