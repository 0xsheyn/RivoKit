/**
 * CPN payload encryption — JWE between the OFI and the network.
 *
 * Travel Rule and beneficiary account data are PII, so CPN never takes them in
 * the clear. After a quote, the quote's `certificate` carries an ephemeral EC
 * P-256 public key (`jwk`); the OFI encrypts the sensitive JSON to that key and
 * sends only the compact JWE in createPayment (and later, RFI responses).
 *
 * The scheme is fixed by Circle (verified against the encrypt-travel-rule
 * how-to): JWE compact serialization, key agreement **ECDH-ES+A128KW**, content
 * encryption **A128GCM**. Any of these wrong and the BFI cannot decrypt, so they
 * are constants here, not options.
 *
 * The how-to also requires verifying that the certificate's public key matches
 * the advertised `jwk` before trusting it — otherwise a swapped jwk could route
 * ciphertext to a key the real BFI doesn't hold. `certMatchesJwk` does that
 * check against the X.509 cert Circle ships in the same quote.
 */
import { CompactEncrypt, importJWK } from "jose";
import { X509Certificate } from "node:crypto";

export type CpnJwk = {
  kty: string;
  crv: string;
  kid?: string;
  x: string;
  y: string;
};

const ALG = "ECDH-ES+A128KW";
const ENC = "A128GCM";

/**
 * Encrypt a JSON-serializable payload to a quote's JWK, returning the compact
 * JWE string to hand to createPayment. Pure with respect to the network — the
 * only input that varies is the recipient key.
 */
export async function encryptForCpn(payload: unknown, jwk: CpnJwk): Promise<string> {
  const key = await importJWK({ ...jwk, alg: ALG }, ALG);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return await new CompactEncrypt(bytes).setProtectedHeader({ alg: ALG, enc: ENC }).encrypt(key);
}

/** One travel-rule / beneficiary field. ADDRESS values are objects, others strings. */
export type CpnFieldValue = { name: string; value: string | Record<string, unknown> };

/**
 * Encrypt the travel-rule and beneficiary-account field arrays to a quote's JWK,
 * returning the two JWE strings createPayment expects as `travelRuleData` and
 * `beneficiaryAccountData`. Each side is a JSON array of {name, value}, encrypted
 * whole (not per field).
 */
export async function encryptPaymentData(
  travelRule: CpnFieldValue[],
  beneficiaryAccount: CpnFieldValue[],
  jwk: CpnJwk,
): Promise<{ travelRuleData: string; beneficiaryAccountData: string }> {
  const [travelRuleData, beneficiaryAccountData] = await Promise.all([
    encryptForCpn(travelRule, jwk),
    encryptForCpn(beneficiaryAccount, jwk),
  ]);
  return { travelRuleData, beneficiaryAccountData };
}

/**
 * The quote's `certificate.certPem` is a base64-wrapped PEM. Decode it, parse
 * the X.509 cert, and confirm its public key's (x, y) equal the advertised JWK.
 * Returns false on any parse failure rather than throwing — a bad certificate is
 * a "do not trust this quote" signal the caller acts on, not a crash.
 */
export function certMatchesJwk(certPemBase64: string, jwk: CpnJwk): boolean {
  try {
    const pemText = Buffer.from(certPemBase64, "base64").toString("utf8");
    // The decoded PEM may lack line breaks; pull the DER base64 out by markers.
    const b64 = pemText
      .replace(/-----BEGIN CERTIFICATE-----/, "")
      .replace(/-----END CERTIFICATE-----/, "")
      .replace(/\s+/g, "");
    const cert = new X509Certificate(Buffer.from(b64, "base64"));
    const certJwk = cert.publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
    return certJwk.x === jwk.x && certJwk.y === jwk.y;
  } catch {
    return false;
  }
}
