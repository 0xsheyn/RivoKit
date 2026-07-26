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
import { getRivoKit } from "@/lib/rivokit.server";
import { handleCircleWebhook } from "../../../../../src/events/webhook-handler.ts";

export async function POST(req: Request): Promise<Response> {
  const { store, resolveWebhookPublicKey } = getRivoKit();

  // RAW bytes — never req.json(). Re-serializing reorders keys and drops
  // whitespace, so the signature would no longer match what Circle signed.
  const rawBody = await req.text();

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
