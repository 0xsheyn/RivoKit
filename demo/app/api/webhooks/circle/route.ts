/**
 * POST /api/webhooks/circle — the HTTP mouth of the webhook pipeline.
 *
 * The one job that MUST happen here, not in the handler: read the RAW request
 * body. `req.json()` would re-serialize and break the signature check, so this
 * route takes `req.text()` and hands the exact bytes to handleCircleWebhook,
 * which verifies, parses, correlates the txHash to an order, and records the
 * event. Signature key and store come from the same server wiring the rest of
 * the demo uses.
 *
 * Not yet live-proven end-to-end: proving it needs a public URL registered as a
 * Circle notification subscription. The verify→correlate→record path itself is
 * covered by src/events/webhook-handler.test.ts against a real P-256 keypair.
 */
// NOT `getRivoKit()`. That builds App Kit and the Circle Wallets adapter, whose
// Solana dependency chain ends in a CommonJS module that `require()`s an ESM
// one — the module then fails to load and every request here answers 500,
// including the `HEAD` Circle validates a subscription with. See
// `demo/lib/webhook.server.ts` for the full account.
import { getWebhookDeps } from "@/lib/webhook.server";
import { handleCircleWebhook } from "../../../../../src/events/webhook-handler.ts";
import { verifyAndInterpretCpn } from "../../../../../src/ramp/cpn-state.ts";
import { applyCpnEventToStore } from "../../../../../src/ramp/cpn-sync.ts";

/** Does this body claim to be a CPN notification? Claim only — unverified. */
function looksLikeCpn(rawBody: string): boolean {
  try {
    const t = (JSON.parse(rawBody) as { notificationType?: unknown })?.notificationType;
    return typeof t === "string" && t.startsWith("cpn.");
  } catch {
    return false;
  }
}

/**
 * Circle validates a subscriber URL with `HEAD` before it will create the
 * subscription — notification API v2, which is what CPN, Wallets, Contracts,
 * Gateway and StableFX all use. A route that exports only `POST` answers 405,
 * the subscription is refused, and no event ever arrives: the endpoint looks
 * finished while being unreachable by construction. Nothing to verify here —
 * the request carries no body and no signature.
 */
export async function HEAD(): Promise<Response> {
  return new Response(null, { status: 200 });
}

export async function POST(req: Request): Promise<Response> {
  const { store, resolveWebhookPublicKey } = getWebhookDeps();

  // RAW bytes — never req.json(). Re-serializing reorders keys and drops
  // whitespace, so the signature would no longer match what Circle signed.
  const rawBody = await req.text();

  // CPN drives cash-outs on its own clock, so its events take a different path:
  // they fold into `cpn_payments`, not into an order. The signature is still
  // verified FIRST — `looksLikeCpn` only routes, it never grants trust.
  if (looksLikeCpn(rawBody)) {
    const signatureBase64 = req.headers.get("X-Circle-Signature");
    // CPN keys live on their own path — see resolveWebhookPublicKey.
    const publicKey = await resolveWebhookPublicKey(
      req.headers.get("X-Circle-Key-Id") ?? undefined,
      "cpn",
    );
    if (!signatureBase64 || !publicKey) {
      return Response.json({ ok: false, reason: "unverifiable" }, { status: 401 });
    }
    try {
      const event = verifyAndInterpretCpn({ rawBody, signatureBase64, publicKey });
      if (!event) return Response.json({ ok: false, reason: "not-cpn" }, { status: 400 });
      const result = await applyCpnEventToStore(store, event);
      return Response.json({ ok: true, ...result });
    } catch {
      // verifyAndInterpretCpn throws on a bad signature, and only on that.
      return Response.json({ ok: false, reason: "bad-signature" }, { status: 401 });
    }
  }

  const result = await handleCircleWebhook(
    { store, resolvePublicKey: resolveWebhookPublicKey },
    {
      rawBody,
      signatureBase64: req.headers.get("X-Circle-Signature") ?? undefined,
      keyId: req.headers.get("X-Circle-Key-Id") ?? undefined,
    },
  );

  if (!result.ok) {
    return Response.json({ ok: false, reason: result.reason }, { status: result.status });
  }
  return Response.json({ ok: true, orderId: result.orderId, type: result.event.type });
}
