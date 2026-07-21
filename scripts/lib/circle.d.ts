// Types for the plain-JS Circle REST client (circle.mjs), so TS consumers
// (the demo server module) import it typed.

export class CircleError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown);
}

export type CircleTransaction = {
  transaction?: { id: string; state?: string; txHash?: string; errorReason?: string };
};

export type CircleClient = {
  request(method: string, path: string, body?: unknown): Promise<any>;
  getPublicKey(): Promise<string>;
  entitySecretCiphertext(): Promise<string>;
  signedPost(path: string, body?: unknown): Promise<any>;
  contractExecution(args: {
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: unknown[];
    feeLevel?: string;
  }): Promise<{ id: string }>;
  getTransaction(id: string): Promise<CircleTransaction>;
  getWalletBalance(walletId: string): Promise<any>;
  listWallets(query?: string): Promise<any>;
};

export function createCircleClient(config: { apiKey: string; entitySecret: string }): CircleClient;
