/**
 * CPN payment lifecycle — interpret webhooks and advance state safely.
 *
 * CPN drives a payment through its states asynchronously and tells the OFI via
 * webhooks (`cpn.payment.*`, `cpn.rfi.*`, `cpn.transaction.*`, `cpn.refund.*`,
 * envelope `{notificationType, notification}`). Two facts shape this module:
 *
 *   - Webhooks are unauthenticated POSTs. `verifyAndInterpretCpn` verifies the
 *     Circle signature (reusing events/webhook.ts) before returning anything, so
 *     nothing downstream acts on an unverified body.
 *   - Webhooks arrive out of order and more than once. The reducers therefore
 *     only ever move a payment FORWARD along the legal graph and never out of a
 *     terminal state — a late `cryptoFundsPending` after `completed` is ignored,
 *     not replayed. This keeps at-least-once delivery from corrupting state.
 *
 * The functions are pure (state in, decision out); wiring them to the order
 * store is Stage 6.
 */
import { verifyCircleSignature } from "../events/webhook.ts";

export type CpnPaymentState =
  | "CREATED"
  | "CRYPTO_FUNDS_PENDING"
  | "FIAT_PAYMENT_INITIATED"
  | "COMPLETED"
  | "FAILED";

export type CpnTransactionState = "CREATED" | "PENDING" | "BROADCASTED" | "COMPLETED" | "FAILED";
export type CpnRfiState = "INFORMATION_REQUIRED" | "IN_REVIEW" | "APPROVED" | "FAILED";
export type CpnRefundState = "CREATED" | "COMPLETED" | "FAILED";

export type CpnComponent = "payment" | "rfi" | "transaction" | "refund";

/** A verified, normalized CPN webhook. */
export type CpnEvent = {
  component: CpnComponent;
  notificationType: string;
  paymentId?: string | undefined;
  /** The payment/tx/rfi/refund status the event implies, when it maps to one. */
  status?: string | undefined;
  raw: unknown;
};

// ── Payment state graph ────────────────────────────────────────────────

const PAYMENT_NEXT: Record<CpnPaymentState, CpnPaymentState[]> = {
  CREATED: ["CRYPTO_FUNDS_PENDING", "FAILED"],
  CRYPTO_FUNDS_PENDING: ["FIAT_PAYMENT_INITIATED", "FAILED"],
  FIAT_PAYMENT_INITIATED: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export function isPaymentTerminal(s: CpnPaymentState): boolean {
  return s === "COMPLETED" || s === "FAILED";
}

export function canTransitionPayment(from: CpnPaymentState, to: CpnPaymentState): boolean {
  return PAYMENT_NEXT[from]?.includes(to) ?? false;
}

/** notificationType → the payment state it drives, or null for metadata-only events. */
const PAYMENT_EVENT_STATE: Record<string, CpnPaymentState | null> = {
  "cpn.payment.cryptoFundsPending": "CRYPTO_FUNDS_PENDING",
  "cpn.payment.fiatPaymentInitiated": "FIAT_PAYMENT_INITIATED",
  "cpn.payment.completed": "COMPLETED",
  "cpn.payment.failed": "FAILED",
  // No status change: a delay estimate, or a manual-review hold that keeps CREATED.
  "cpn.payment.delayed": null,
  "cpn.payment.inManualReview": null,
};

export type ApplyOutcome =
  | { state: CpnPaymentState; changed: true }
  | { state: CpnPaymentState; changed: false; reason: "no-op" | "duplicate" | "illegal" | "not-payment" };

/**
 * Fold a webhook event into the current payment state. Forward-only and
 * terminal-safe: duplicates and out-of-order/backward events leave the state
 * untouched and say why, rather than throwing or regressing.
 */
export function applyPaymentEvent(current: CpnPaymentState, event: CpnEvent): ApplyOutcome {
  if (event.component !== "payment") return { state: current, changed: false, reason: "not-payment" };

  const target = PAYMENT_EVENT_STATE[event.notificationType];
  if (target === undefined || target === null) return { state: current, changed: false, reason: "no-op" };
  if (target === current) return { state: current, changed: false, reason: "duplicate" };
  if (isPaymentTerminal(current)) return { state: current, changed: false, reason: "illegal" };
  if (!canTransitionPayment(current, target)) return { state: current, changed: false, reason: "illegal" };
  return { state: target, changed: true };
}

// ── Transaction & RFI helpers ──────────────────────────────────────────

const TRANSACTION_ORDER: CpnTransactionState[] = ["CREATED", "PENDING", "BROADCASTED", "COMPLETED"];

/** BROADCASTED is the point of no return: funds have left the sender irreversibly. */
export function isPointOfNoReturn(s: CpnTransactionState): boolean {
  return s === "BROADCASTED" || s === "COMPLETED";
}

const TRANSACTION_EVENT_STATE: Record<string, CpnTransactionState> = {
  "cpn.transaction.broadcasted": "BROADCASTED",
  "cpn.transaction.completed": "COMPLETED",
  "cpn.transaction.failed": "FAILED",
};

const RFI_EVENT_STATE: Record<string, CpnRfiState> = {
  "cpn.rfi.informationRequired": "INFORMATION_REQUIRED",
  "cpn.rfi.inReview": "IN_REVIEW",
  "cpn.rfi.approved": "APPROVED",
  "cpn.rfi.rejected": "FAILED",
};

/**
 * What an RFI event means for the payment. An open RFI blocks progress; a
 * rejection (RFI FAILED) fails the whole payment; approval unblocks it.
 */
export function rfiEffect(event: CpnEvent): { state: CpnRfiState; blocksPayment: boolean; failsPayment: boolean } | null {
  const state = RFI_EVENT_STATE[event.notificationType];
  if (!state) return null;
  return {
    state,
    blocksPayment: state === "INFORMATION_REQUIRED" || state === "IN_REVIEW",
    failsPayment: state === "FAILED",
  };
}

// ── Event interpretation & verification ────────────────────────────────

function componentOf(notificationType: string): CpnComponent | null {
  if (notificationType.startsWith("cpn.payment.")) return "payment";
  if (notificationType.startsWith("cpn.rfi.")) return "rfi";
  if (notificationType.startsWith("cpn.transaction.")) return "transaction";
  if (notificationType.startsWith("cpn.refund.")) return "refund";
  return null;
}

/**
 * Normalize a CPN webhook envelope into a CpnEvent, or null if it is not a CPN
 * event (e.g. a Wallets/Gateway notification delivered on the same channel).
 * Does NOT verify the signature — callers must use verifyAndInterpretCpn, or
 * verify first themselves.
 */
export function interpretCpnEvent(payload: unknown): CpnEvent | null {
  const p = (payload ?? {}) as Record<string, any>;
  const notificationType: string | undefined = p.notificationType;
  if (!notificationType) return null;
  const component = componentOf(notificationType);
  if (!component) return null;

  const n = (p.notification ?? {}) as Record<string, any>;
  const paymentId: string | undefined = n.paymentId ?? (component === "payment" ? n.id : undefined);
  const status: string | undefined = n.status ?? undefined;
  return { component, notificationType, paymentId, status, raw: payload };
}

export type VerifyAndInterpretParams = {
  /** EXACT raw bytes of the request body. */
  rawBody: string | Buffer;
  /** `X-Circle-Signature`, base64. */
  signatureBase64: string;
  /** Circle's ECDSA public key (PEM or base64/DER SPKI). */
  publicKey: string;
};

/**
 * Verify the webhook signature, then interpret it. Throws on a bad signature so
 * an unverified body can never reach the reducers; returns null for a verified
 * but non-CPN payload.
 */
export function verifyAndInterpretCpn(params: VerifyAndInterpretParams): CpnEvent | null {
  const ok = verifyCircleSignature({
    rawBody: params.rawBody,
    signatureBase64: params.signatureBase64,
    publicKey: params.publicKey,
  });
  if (!ok) throw new Error("verifyAndInterpretCpn: tanda tangan webhook tidak sah");
  const body = typeof params.rawBody === "string" ? params.rawBody : params.rawBody.toString("utf8");
  return interpretCpnEvent(JSON.parse(body));
}
