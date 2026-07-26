import { describe, expect, it, vi, beforeAll } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { handleCircleWebhook, type WebhookHandlerDeps } from "./webhook-handler.ts";

// A real ECDSA P-256 keypair — the scheme Circle notifications actually use — so
// the test exercises the true verify path, not a stub.
let publicKeyPem: string;
let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];

beforeAll(() => {
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  privateKey = kp.privateKey;
  publicKeyPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
});

const sign = (body: string) => cryptoSign("sha256", Buffer.from(body, "utf8"), privateKey).toString("base64");

function makeDeps(over: { orderId?: string | null } = {}) {
  const store = {
    findOrderIdByTxHash: vi.fn(async (_hash: string) => over.orderId ?? null),
    recordEvent: vi.fn(async (_p: Record<string, unknown>) => {}),
  };
  const deps: WebhookHandlerDeps = {
    store: store as never,
    resolvePublicKey: () => publicKeyPem,
  };
  return { deps, store };
}

describe("handleCircleWebhook", () => {
  it("verifies, correlates the txHash to an order, and records a verified event", async () => {
    const body = JSON.stringify({ notificationType: "transactions.outbound", data: { txHash: "0xcap", state: "COMPLETE" } });
    const { deps, store } = makeDeps({ orderId: "ord_42" });

    const res = await handleCircleWebhook(deps, { rawBody: body, signatureBase64: sign(body), keyId: "k1" });

    expect(res).toMatchObject({ ok: true, verified: true, orderId: "ord_42" });
    expect(store.findOrderIdByTxHash).toHaveBeenCalledWith("0xcap");
    expect(store.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "ord_42", type: "transactions.outbound", sigVerified: true }),
    );
  });

  it("records the event unattributed when the txHash matches no order", async () => {
    const body = JSON.stringify({ notificationType: "transactions.inbound", data: { txHash: "0xstranger" } });
    const { deps, store } = makeDeps({ orderId: null });

    const res = await handleCircleWebhook(deps, { rawBody: body, signatureBase64: sign(body), keyId: "k1" });

    expect(res).toMatchObject({ ok: true, orderId: null });
    // recordEvent still runs, but with no order_id — visible, not mis-routed.
    const arg = store.recordEvent.mock.calls[0]![0];
    expect(arg.orderId).toBeUndefined();
    expect(arg.sigVerified).toBe(true);
  });

  it("rejects a bad signature with 401 and records nothing", async () => {
    const body = JSON.stringify({ notificationType: "transactions.inbound", data: { txHash: "0xcap" } });
    const tampered = body.replace("0xcap", "0xevil");
    const { deps, store } = makeDeps({ orderId: "ord_42" });

    const res = await handleCircleWebhook(deps, { rawBody: tampered, signatureBase64: sign(body), keyId: "k1" });

    expect(res).toEqual({ ok: false, status: 401, reason: "tanda tangan tidak sah" });
    expect(store.recordEvent).not.toHaveBeenCalled();
    expect(store.findOrderIdByTxHash).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 401 before any work", async () => {
    const { deps, store } = makeDeps();
    const res = await handleCircleWebhook(deps, { rawBody: "{}", keyId: "k1" });
    expect(res).toMatchObject({ ok: false, status: 401 });
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the public key can't be resolved", async () => {
    const body = "{}";
    const { deps, store } = makeDeps();
    deps.resolvePublicKey = () => null;
    const res = await handleCircleWebhook(deps, { rawBody: body, signatureBase64: sign(body), keyId: "unknown" });
    expect(res).toMatchObject({ ok: false, status: 401 });
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for a verified body that isn't JSON", async () => {
    const body = "not json at all";
    const { deps, store } = makeDeps();
    const res = await handleCircleWebhook(deps, { rawBody: body, signatureBase64: sign(body), keyId: "k1" });
    expect(res).toEqual({ ok: false, status: 400, reason: "body bukan JSON yang sah" });
    expect(store.recordEvent).not.toHaveBeenCalled();
  });
});
