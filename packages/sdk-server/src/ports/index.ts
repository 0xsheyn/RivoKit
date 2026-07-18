/**
 * PORTS — inti SDK tak pernah bicara langsung ke StableFX/CPN/Circle Wallets.
 * Setiap vendor masuk lewat adapter yang mengimplementasikan port di bawah
 * (arsitektur hexagonal, CONCEPT §11).
 */
import type { Money, OrderId } from "@rivokit/core";

export interface WalletPort {
  /** Wallet user WAJIB SCA (bukan EOA) — syarat gas sponsorship. */
  createUserWallet(input: { externalId: string }): Promise<{ address: string; walletId: string }>;
  getBalances(address: string): Promise<readonly Money[]>;
}

export interface FxPort {
  /** Mid-rate; margin dilaporkan terpisah sebagai fee. */
  getMidRate(from: Money["currency"], to: Money["currency"]): Promise<string>;
  /** Penjual = taker PvP; platform tak warehouse posisi FX. */
  execute(input: { amount: Money; to: Money["currency"]; takerSig: string; maxSlippageBps: number }): Promise<{ txHash: string }>;
}

export interface RampPort {
  withdraw(input: {
    amount: Money;
    destination: { type: "bank"; rail: "sepa" | "ach" | "wire"; iban?: string; routing?: string };
    idempotencyKey: string;
  }): Promise<{ payoutId: string; status: string }>;
  /** RECONCILE untuk leg irreversible saat ACK hilang. */
  getPayout(payoutId: string): Promise<{ status: string }>;
}

export interface GasPort {
  /** User bayar gas dalam USDC (native di Arc, Paymaster di spoke). */
  sponsor(input: { chain: string; userOp: unknown }): Promise<{ paymasterData: string }>;
}

export interface BridgePort {
  transfer(input: { amount: Money; fromChain: string; toChain: string; recipient: string }): Promise<{ txHash: string }>;
  getStatus(txHash: string): Promise<{ status: string; mintTxHash: string | null }>;
}

export interface ChainPort {
  waitForConfirmation(txHash: string): Promise<{ confirmed: boolean; blockNumber: bigint }>;
}

export interface EscrowContractPort {
  open(input: { orderId: OrderId; payee: string; arbiter: string; amount: Money; shipDeadline: number; confirmWindow: number }): Promise<{ txHash: string }>;
  /** Relayer hanya SUBMIT — otorisasi datang dari signature payer. */
  fund(input: { orderId: OrderId; payerAuth: string }): Promise<{ txHash: string }>;
  /** Tak ada parameter alamat: tujuan dipatok ke order.payee (invariant #1). */
  confirmReceipt(input: { orderId: OrderId; payerSig: string }): Promise<{ txHash: string }>;
  autoRelease(orderId: OrderId): Promise<{ txHash: string }>;
  claimRefund(orderId: OrderId): Promise<{ txHash: string }>;
}
