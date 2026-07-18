import type { Money, Payment, PaymentEventType } from "@rivokit/core";

/**
 * Client SDK — permukaan sisi-browser.
 *
 * INVARIANT: Host tak pernah melihat istilah crypto. Tak ada "EURC", "Permit2",
 * "chain", atau "gas" di tipe publik mana pun di file ini (invariant #6 & #7).
 */
export interface RivoClientConfig {
  readonly appId: string;
  readonly apiUrl: string;
}

/** Saldo untuk ditampilkan sebagai uang, bukan token. */
export interface DisplayBalance {
  readonly currency: Money["currency"];
  readonly form: "stablecoin" | "fiat";
  /** Sudah diformat, mis. `"$540.00"`. */
  readonly display: string;
}

export interface PayInput {
  readonly to: string;
  readonly amount: Money;
  readonly idempotencyKey: string;
}

export class RivoClient {
  constructor(private readonly config: RivoClientConfig) {}

  /** Passkey (WebAuthn) → wallet user-controlled SCA. TODO(M1). */
  async connect(): Promise<{ accountId: string }> {
    throw new Error("not implemented: connect()");
  }

  async getBalances(): Promise<readonly DisplayBalance[]> {
    throw new Error("not implemented: getBalances()");
  }

  async pay(_input: PayInput): Promise<Payment> {
    throw new Error("not implemented: pay()");
  }

  /** Status live via Supabase Realtime. TODO(M3). */
  on(_event: PaymentEventType, _handler: (payment: Payment) => void): () => void {
    throw new Error("not implemented: on()");
  }
}

export const RivoKit = {
  client: (config: RivoClientConfig): RivoClient => new RivoClient(config),
};
