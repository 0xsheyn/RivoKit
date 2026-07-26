/**
 * Circle webhook intake — the composed pipeline behind an HTTP endpoint.
 *
 * `webhook.ts` gives the two pure primitives: verify a signature over raw bytes,
 * and normalize a verified payload. This module wires them into the order flow:
 *
 *   verify (raw bytes) → parse → correlate txHash→order → record
 *
 * The ordering is the security property. Nothing about the payload is trusted
 * before the signature clears, so an unverified POST is recorded as unverified —
 * never correlated to an order, never allowed to advance one. Correlation runs
 * off the payments table (the txHash→order index): a webhook for a transaction we
 * never recorded is stored unattributed rather than pinned onto an arbitrary
 * order.
 *
 * This module does NOT decide funds — the chain and the store already did. It
 * turns a verified notification into a durable, attributed event row (PRD US-06),
 * which is what lets a host react without polling.
 */
import type { OrderStore } from "../orchestrator/order-store.ts";
import { verifyCircleSignature, parseWebhookEvent, type WebhookEvent } from "./webhook.ts";

export type WebhookRequest = {
  /** The EXACT bytes received. Verifying a re-serialized copy breaks the check. */
  rawBody: string | Buffer;
  /** `X-Circle-Signature`, base64. Absent → treated as unverified. */
  signatureBase64?: string | undefined;
  /** `X-Circle-Key-Id` — which Circle public key signed this. */
  keyId?: string | undefined;
};

export type WebhookHandlerDeps = {
  store: Pick<OrderStore, "findOrderIdByTxHash" | "recordEvent">;
  /**
   * Circle's ECDSA public key for a given key id (PEM or base64 DER SPKI).
   * Injected because fetching it is an authenticated Circle API call that belongs
   * to the host's environment, not this module. Return null/throw if unknown —
   * the webhook is then rejected as unverifiable.
   */
  resolvePublicKey: (keyId: string | undefined) => Promise<string | null> | string | null;
};

export type WebhookResult =
  | {
      ok: true;
      /** Always true on the ok path — an unverified webhook never reaches here. */
      verified: true;
      /** The order this event was tied to, or null when the txHash isn't ours. */
      orderId: string | null;
      event: WebhookEvent;
    }
  | {
      ok: false;
      /** HTTP status the endpoint should return. */
      status: 400 | 401;
      reason: string;
    };

/**
 * Verify, parse, correlate, and record one Circle webhook.
 *
 * On a bad or missing signature it records nothing and asks the caller to return
 * 401 — an unauthenticated POST must not leave a trusted-looking trace. On a
 * malformed body it returns 400. Only a verified payload is parsed, correlated to
 * an order via its txHash, and written as a `sig_verified` event.
 */
export async function handleCircleWebhook(
  deps: WebhookHandlerDeps,
  req: WebhookRequest,
): Promise<WebhookResult> {
  if (!req.signatureBase64) {
    return { ok: false, status: 401, reason: "missing X-Circle-Signature header" };
  }

  let publicKey: string | null;
  try {
    publicKey = await deps.resolvePublicKey(req.keyId);
  } catch {
    publicKey = null;
  }
  if (!publicKey) {
    return { ok: false, status: 401, reason: `no public key found for keyId ${req.keyId ?? "?"}` };
  }

  const verified = verifyCircleSignature({
    rawBody: req.rawBody,
    signatureBase64: req.signatureBase64,
    publicKey,
  });
  if (!verified) {
    return { ok: false, status: 401, reason: "invalid signature" };
  }

  // Parse the RAW bytes we just verified — never a re-serialized copy.
  const rawText = typeof req.rawBody === "string" ? req.rawBody : req.rawBody.toString("utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return { ok: false, status: 400, reason: "body is not valid JSON" };
  }

  const event = parseWebhookEvent(payload);

  // Correlate on the txHash when present; a webhook without one (or with a hash we
  // never recorded) is stored unattributed rather than mis-routed.
  const orderId = event.txHash ? await deps.store.findOrderIdByTxHash(event.txHash) : null;

  await deps.store.recordEvent({
    ...(orderId ? { orderId } : {}),
    type: event.type,
    payload,
    sigVerified: true,
  });

  return { ok: true, verified: true, orderId, event };
}
