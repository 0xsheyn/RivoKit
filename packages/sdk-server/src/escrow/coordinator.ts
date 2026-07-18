import type { Money, OrderId } from "@rivokit/core";
import type { EscrowContractPort } from "../ports/index.js";

/**
 * Escrow Coordinator — pemilik atribusi `(orderId, payer)`.
 *
 * `payer` terkunci saat `authorized` (dari event `Deposited(orderId, payer, amount)`),
 * read-only sesudahnya. Inilah yang membuat "dua pembeli, barang identik"
 * tetap terpisah tanpa memo/invoice (CONCEPT §9).
 */
export interface EscrowBinding {
  readonly orderId: OrderId;
  readonly payer: string;
  readonly payee: string;
  readonly amount: Money;
  readonly txHash: string;
}

export class EscrowCoordinator {
  constructor(private readonly contract: EscrowContractPort) {}

  /** TODO(M1): open → fund → tunggu Deposited → kunci binding → ledger. */
  async hold(): Promise<EscrowBinding> {
    throw new Error("not implemented: EscrowCoordinator.hold()");
  }

  /** TODO(M1): confirmReceipt / autoRelease → handoff intent penjual. */
  async release(): Promise<{ txHash: string }> {
    throw new Error("not implemented: EscrowCoordinator.release()");
  }

  /** Refund pra-rilis mengembalikan USDC asli — nol slippage (R3). */
  async refund(): Promise<{ txHash: string }> {
    throw new Error("not implemented: EscrowCoordinator.refund()");
  }
}
