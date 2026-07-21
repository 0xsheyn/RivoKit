import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { verifyCircleSignature, parseWebhookEvent } from "./webhook.ts";

// A real ECDSA P-256 keypair, so the test exercises the actual crypto path
// rather than a stub. This is exactly the scheme Circle notifications use.
let publicKeyPem: string;
let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
let wrongPublicKeyPem: string;

beforeAll(() => {
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  privateKey = kp.privateKey;
  publicKeyPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
  wrongPublicKeyPem = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
});

const signBody = (body: string) => cryptoSign("sha256", Buffer.from(body, "utf8"), privateKey).toString("base64");

describe("verifyCircleSignature", () => {
  const body = JSON.stringify({ notificationType: "transactions.inbound", txHash: "0xabc" });

  it("accepts a signature made over the exact raw body", () => {
    expect(verifyCircleSignature({ rawBody: body, signatureBase64: signBody(body), publicKey: publicKeyPem })).toBe(true);
  });

  it("rejects when the body was tampered with after signing", () => {
    const sig = signBody(body);
    const tampered = body.replace("0xabc", "0xdead");
    expect(verifyCircleSignature({ rawBody: tampered, signatureBase64: sig, publicKey: publicKeyPem })).toBe(false);
  });

  it("rejects a signature verified against the wrong public key", () => {
    expect(verifyCircleSignature({ rawBody: body, signatureBase64: signBody(body), publicKey: wrongPublicKeyPem })).toBe(false);
  });

  it("rejects an empty or malformed signature instead of throwing", () => {
    expect(verifyCircleSignature({ rawBody: body, signatureBase64: "", publicKey: publicKeyPem })).toBe(false);
    expect(verifyCircleSignature({ rawBody: body, signatureBase64: "!!notbase64!!", publicKey: publicKeyPem })).toBe(false);
    expect(verifyCircleSignature({ rawBody: body, signatureBase64: signBody(body), publicKey: "not a key" })).toBe(false);
  });

  it("verifies identically whether the body is a string or a Buffer", () => {
    const sig = signBody(body);
    expect(verifyCircleSignature({ rawBody: Buffer.from(body, "utf8"), signatureBase64: sig, publicKey: publicKeyPem })).toBe(true);
  });
});

describe("parseWebhookEvent", () => {
  it("recognizes a transactions notification and pulls the tx hash", () => {
    const e = parseWebhookEvent({ notificationType: "transactions.inbound", data: { txHash: "0xabc", state: "COMPLETE" } });
    expect(e).toMatchObject({ source: "transactions", type: "transactions.inbound", txHash: "0xabc", state: "COMPLETE" });
  });

  it("recognizes a gateway deposit finalized event", () => {
    const e = parseWebhookEvent({ notificationType: "gateway.deposit.finalized", data: { txHash: "0xdep" } });
    expect(e.source).toBe("gateway");
    expect(e.txHash).toBe("0xdep");
  });

  it("recognizes an SCP contract event by its shape", () => {
    const e = parseWebhookEvent({ contractAddress: "0xesc", eventName: "PaymentAuthorized", transactionHash: "0xtx" });
    expect(e).toMatchObject({ source: "scp", type: "PaymentAuthorized", txHash: "0xtx" });
  });

  it("reports unknown rather than guessing for an unrecognized payload", () => {
    expect(parseWebhookEvent({ foo: "bar" }).source).toBe("unknown");
    expect(parseWebhookEvent(null).source).toBe("unknown");
  });
});
