/**
 * Minimal Circle REST client for Developer-Controlled Wallets.
 *
 * We call REST directly instead of using @circle-fin/developer-controlled-wallets
 * because that package declares a peerOptional dependency on
 * @solana/codecs-strings@^2, which conflicts with the v5 that App Kit already
 * pulls in. Forcing it with --legacy-peer-deps would leave a tree that resolves
 * but may misbehave, and the Solana codecs are irrelevant to an EVM-only app.
 *
 * The only non-trivial part is entitySecretCiphertext: Circle requires the
 * 32-byte entity secret RSA-OAEP encrypted under their per-account public key,
 * FRESH FOR EVERY mutating request (the ciphertext is single-use).
 */
import { constants, publicEncrypt, randomUUID } from "node:crypto";

const BASE = "https://api.circle.com";

export class CircleError extends Error {
  constructor(status, body) {
    super(`Circle HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "CircleError";
    this.status = status;
    this.body = body;
  }
}

export function createCircleClient({ apiKey, entitySecret }) {
  if (!apiKey) throw new Error("CIRCLE_API_KEY kosong");
  if (!entitySecret) throw new Error("CIRCLE_ENTITY_SECRET kosong");

  let cachedPublicKey = null;

  async function request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) throw new CircleError(res.status, parsed);
    return parsed?.data ?? parsed;
  }

  async function getPublicKey() {
    if (cachedPublicKey) return cachedPublicKey;
    const data = await request("GET", "/v1/w3s/config/entity/publicKey");
    cachedPublicKey = data.publicKey;
    return cachedPublicKey;
  }

  /**
   * Single-use ciphertext. Never cache the RESULT — Circle rejects reuse.
   */
  async function entitySecretCiphertext() {
    const publicKey = await getPublicKey();
    const secretBytes = Buffer.from(entitySecret, "hex");
    if (secretBytes.length !== 32) {
      throw new Error(
        `CIRCLE_ENTITY_SECRET harus 32 byte hex, dapat ${secretBytes.length} byte`,
      );
    }
    return publicEncrypt(
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      secretBytes,
    ).toString("base64");
  }

  /** POST with a fresh ciphertext and idempotency key mixed in. */
  async function signedPost(path, body) {
    return request("POST", path, {
      idempotencyKey: randomUUID(),
      entitySecretCiphertext: await entitySecretCiphertext(),
      ...body,
    });
  }

  return {
    request,
    getPublicKey,
    entitySecretCiphertext,
    signedPost,

    listWalletSets: () => request("GET", "/v1/w3s/walletSets"),
    createWalletSet: (name) => signedPost("/v1/w3s/developer/walletSets", { name }),

    listWallets: (query = "") => request("GET", `/v1/w3s/wallets${query}`),
    createWallets: ({ walletSetId, blockchains, count, accountType }) =>
      signedPost("/v1/w3s/developer/wallets", {
        walletSetId,
        blockchains,
        count,
        ...(accountType ? { accountType } : {}),
      }),

    getWalletBalance: (walletId) =>
      request("GET", `/v1/w3s/wallets/${walletId}/balances`),

    /**
     * Call a contract function from a Developer-Controlled wallet.
     *
     * `abiFunctionSignature` is the solidity signature, e.g.
     * "approve(address,uint256)"; `abiParameters` are positional and must be
     * JSON-encodable (tuples as nested arrays).
     */
    contractExecution: ({ walletId, contractAddress, abiFunctionSignature, abiParameters, feeLevel = "MEDIUM" }) =>
      signedPost("/v1/w3s/developer/transactions/contractExecution", {
        walletId,
        contractAddress,
        abiFunctionSignature,
        abiParameters,
        feeLevel,
      }),

    getTransaction: (id) => request("GET", `/v1/w3s/transactions/${id}`),
  };
}
