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
  if (!apiKey) throw new Error("CIRCLE_API_KEY is empty");
  if (!entitySecret) throw new Error("CIRCLE_ENTITY_SECRET is empty");

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
        `CIRCLE_ENTITY_SECRET must be 32 hex bytes, got ${secretBytes.length} bytes`,
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

    getWallet: (walletId) => request("GET", `/v1/w3s/wallets/${walletId}`),

    /**
     * Sign EIP-712 typed data with a Developer-Controlled wallet.
     *
     * `data` is the typed-data object JSON-STRINGIFIED — Circle takes a string
     * here, not an object, and bigints have to be strings inside it or
     * JSON.stringify throws before the request is ever made.
     *
     * WHAT THE ACCOUNT TYPE DOES TO THE RESULT. An `EOA` wallet returns an
     * ordinary 65-byte ECDSA signature that `ecrecover` resolves back to the
     * wallet's own address. An `SCA` wallet returns an ERC-1271 signature,
     * which is validated by CALLING the account contract and does not recover
     * to anything. Both are "valid signatures"; only the first one works where
     * a counterparty recovers the signer — which is what USDC does for
     * ERC-3009 and what CPN's settlement contract does for a payment intent.
     * `probe-circle-eoa-sign.mjs` is what proves which one you actually have.
     */
    signTypedData: ({ walletId, data, memo }) =>
      signedPost("/v1/w3s/developer/sign/typedData", {
        walletId,
        data: typeof data === "string" ? data : JSON.stringify(data),
        ...(memo ? { memo } : {}),
      }),

    getTransaction: (id) => request("GET", `/v1/w3s/transactions/${id}`),
  };
}
