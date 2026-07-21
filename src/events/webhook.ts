/**
 * Incoming Circle webhooks — verify first, then trust.
 *
 * A webhook is an unauthenticated POST from the public internet. Anything that
 * acts on its contents before verifying the signature is trusting whoever can
 * reach the URL. So the rule this module enforces: verify against Circle's
 * public key over the EXACT raw bytes received, and only a caller holding a
 * verified body may parse it.
 *
 * Two things that quietly break signature checks, guarded here:
 *   - Verifying a re-serialized body. `JSON.parse` then `JSON.stringify` reorders
 *     keys and drops whitespace, so the bytes no longer match what was signed.
 *     Verification MUST run on the raw request body, never a round-tripped copy.
 *   - Comparing with `===`. Signature/tag comparison must be constant-time or it
 *     leaks via timing; Node's `crypto.verify` already is, and the parser never
 *     compares secrets itself.
 *
 * Circle signs notifications with ECDSA; the public key comes from Circle's API
 * (`GET /v2/notifications/publicKey/{keyId}`, id in the `X-Circle-Key-Id`
 * header) and the signature from `X-Circle-Signature`, base64. The curve lives
 * in the key, so one verify path covers it.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export type VerifyParams = {
  /** The EXACT bytes received. Never a re-serialized object. */
  rawBody: string | Buffer;
  /** `X-Circle-Signature`, base64. */
  signatureBase64: string;
  /** Circle's ECDSA public key: PEM, or base64/DER SPKI. */
  publicKey: string;
};

function toKeyObject(publicKey: string) {
  const trimmed = publicKey.trim();
  if (trimmed.includes("-----BEGIN")) return createPublicKey(trimmed);
  // Bare base64 → DER SPKI.
  return createPublicKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "spki" });
}

/**
 * True only if `signatureBase64` is a valid ECDSA-SHA256 signature over
 * `rawBody` under `publicKey`. Any malformed input returns false rather than
 * throwing — a bad signature and a bad key are both "do not trust this".
 */
export function verifyCircleSignature(params: VerifyParams): boolean {
  try {
    const body = typeof params.rawBody === "string" ? Buffer.from(params.rawBody, "utf8") : params.rawBody;
    const sig = Buffer.from(params.signatureBase64, "base64");
    if (sig.length === 0) return false;
    return cryptoVerify("sha256", body, toKeyObject(params.publicKey), sig);
  } catch {
    return false;
  }
}

// ── Event normalization ────────────────────────────────────────────────

export type WebhookSource = "transactions" | "gateway" | "scp" | "unknown";

export type WebhookEvent = {
  source: WebhookSource;
  /** e.g. "transactions.inbound", "gateway.deposit.finalized", a contract event name. */
  type: string;
  /** On-chain tx hash when the payload carries one — the handle we correlate on. */
  txHash?: string | undefined;
  /** Address the event concerns, when present. */
  address?: string | undefined;
  /** State string when the payload carries one (e.g. a transaction state). */
  state?: string | undefined;
  raw: unknown;
};

/**
 * Normalize a VERIFIED payload into a flat event. Callers must verify the
 * signature first — this function trusts its input by contract.
 *
 * It reads defensively across the shapes Circle uses (notification envelope vs
 * SCP contract-event vs Gateway) rather than assuming one, and reports
 * `source: "unknown"` instead of guessing when nothing matches, so an
 * unrecognized payload is visible rather than silently mis-routed.
 */
export function parseWebhookEvent(payload: unknown): WebhookEvent {
  const p = (payload ?? {}) as Record<string, any>;
  const notificationType: string | undefined = p.notificationType ?? p.type;
  const body = (p.notification ?? p.data ?? p) as Record<string, any>;

  const txHash: string | undefined =
    body.txHash ?? body.transactionHash ?? body.transaction?.txHash ?? undefined;
  const address: string | undefined =
    body.address ?? body.destinationAddress ?? body.sourceAddress ?? body.walletAddress ?? undefined;
  const state: string | undefined = body.state ?? body.status ?? undefined;

  let source: WebhookSource = "unknown";
  let type = notificationType ?? "unknown";
  if (notificationType?.startsWith("transactions")) source = "transactions";
  else if (notificationType?.startsWith("gateway") || /gateway/i.test(String(body.eventType))) source = "gateway";
  else if (body.contractAddress || body.eventName || notificationType?.startsWith("contracts")) {
    source = "scp";
    type = body.eventName ?? notificationType ?? "contract.event";
  }

  return { source, type, txHash, address, state, raw: payload };
}
