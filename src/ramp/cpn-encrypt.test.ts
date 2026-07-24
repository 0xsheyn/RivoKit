import { describe, expect, it } from "vitest";
import { compactDecrypt, exportJWK, generateKeyPair } from "jose";
import { certMatchesJwk, encryptForCpn, type CpnJwk } from "./cpn-encrypt.ts";

// A real quote certificate + jwk captured from sandbox (scripts/probe-cpn-quote.mjs).
// The pair is static, so it stays a valid fixture even after the quote expires.
const REAL_CERT_PEM =
  "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tTUlJQnJUQ0NBVktnQXdJQkFnSVVVeVlUb2E3akZJc2JaeDNDUUdKMHg0eCtVVXN3Q2dZSUtvWkl6ajBFQXdJd0tqRVhNQlVHQTFVRUF3d09ZWEJwTG1OcGNtTnNaUzVqYjIweER6QU5CZ05WQkFvTUJrTnBjbU5zWlRBZUZ3MHlOakF6TVRneE5EUXpNREJhRncweU56QXpNVGd4TkRRek1EQmFNQ294RnpBVkJnTlZCQU1NRG1Gd2FTNWphWEpqYkdVdVkyOXRNUTh3RFFZRFZRUUtEQVpEYVhKamJHVXdXVEFUQmdjcWhrak9QUUlCQmdncWhrak9QUU1CQndOQ0FBUmgyTTU0Q2FVMTlaWFRFaXZJVUNLOXluMmgvYld6Uno0bUhJWVE0ZzFYWnArdHRiM3Z6bGY2ZDQzYUhNYlRaQUpPTG1pbkdFZGwxbUZMdFRUTXdYb3ZvMVl3VkRBekJnTlZIUkVFTERBcWdnNWhjR2t1WTJseVkyeGxMbU52YllJU2QzZDNMbUZ3YVM1amFYSmpiR1V1WTI5dGh3UUtBQUFCTUIwR0ExVWREZ1FXQkJSSlBuRHV3YnBqcXNaejlQSGRGcUh1WUlhaERUQUtCZ2dxaGtqT1BRUURBZ05KQURCR0FpRUEwbk53dXVYMXh6SUVZTFhVcnRJM0NQaTB6S2NuOGFLN3RmRjZWR0xvUjRjQ0lRRHcxb3VnZzZjNzViL0tCdElQanBOZ3VNd09mczhiRGU1Qml3UUc1cGdjT3c9PS0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0";
const REAL_JWK: CpnJwk = {
  kty: "EC",
  crv: "P-256",
  x: "YdjOeAmlNfWV0xIryFAivcp9of21s0c-JhyGEOINV2Y",
  y: "n621ve_OV_p3jdocxtNkAk4uaKcYR2XWYUu1NMzBei8",
};

describe("encryptForCpn", () => {
  it("produces a compact JWE (5 parts) that decrypts back to the payload", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES+A128KW", {
      crv: "P-256",
      extractable: true,
    });
    const pub = (await exportJWK(publicKey)) as CpnJwk;
    const payload = {
      travelRule: { ORIGINATOR_NAME: "Rivo Co", BENEFICIARY_NAME: "Acme SARL" },
      beneficiaryAccount: { IBAN: "FR7630006000011234567890189", RECIPIENT_LEGAL_NAME: "Acme SARL" },
    };

    const jwe = await encryptForCpn(payload, pub);
    expect(jwe.split(".")).toHaveLength(5);

    const { plaintext } = await compactDecrypt(jwe, privateKey);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(payload);
  });

  it("stamps the exact algorithm CPN requires in the protected header", async () => {
    const { publicKey } = await generateKeyPair("ECDH-ES+A128KW", { crv: "P-256", extractable: true });
    const pub = (await exportJWK(publicKey)) as CpnJwk;
    const jwe = await encryptForCpn({ a: 1 }, pub);
    const headerB64 = jwe.split(".")[0] ?? "";
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    expect(header.alg).toBe("ECDH-ES+A128KW");
    expect(header.enc).toBe("A128GCM");
  });
});

describe("certMatchesJwk", () => {
  it("accepts the real quote certificate against its own jwk", () => {
    expect(certMatchesJwk(REAL_CERT_PEM, REAL_JWK)).toBe(true);
  });

  it("rejects a jwk whose public point differs from the certificate", () => {
    expect(certMatchesJwk(REAL_CERT_PEM, { ...REAL_JWK, x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toBe(false);
  });

  it("returns false (not throw) on a malformed certificate", () => {
    expect(certMatchesJwk("bm90LWEtY2VydA==", REAL_JWK)).toBe(false);
  });
});
