"use client";

/**
 * Funding rails driven by the CONNECTED wallet, in the browser.
 *
 * The server-signed demo buyer can reach Arc three ways (already on Arc, Gateway
 * unified balance, CCTP bridge from Sepolia) because the server holds its key.
 * A connected wallet must do the same work itself: every one of these calls is
 * signed by the user's wallet, nothing here touches a server secret.
 *
 * Neither Gateway nor CCTP needs a kit key (only swap does), so App Kit can run
 * client-side without shipping KIT_KEY to the browser.
 *
 * Shape of a cross-chain payment, unchanged from the server path: move USDC to
 * the PAYER's own address on Arc first, then let the payer sign ERC-3009 so the
 * operator can pull it into escrow. Never mint straight into the escrow — that
 * would move tokens with no payment recorded against them.
 */
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { createUnifiedBalance } from "../../src/funding/unified-balance.ts";
import { createBridge } from "../../src/funding/bridge.ts";

/** USDC on Ethereum Sepolia — the source chain for both cross-chain rails. */
export const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238" as const;

export type Eip1193 = { request: (args: { method: string; params?: unknown }) => Promise<unknown> };

const kit = new AppKit();
const ub = createUnifiedBalance(kit);
const bridge = createBridge(kit);

// One adapter per provider instance: building it hits the wallet, and App Kit
// caches its own clients behind it.
let cached: { provider: unknown; adapter: unknown } | null = null;

async function adapterFor(provider: Eip1193): Promise<unknown> {
  if (cached && cached.provider === provider) return cached.adapter;
  const adapter = await createViemAdapterFromProvider({ provider: provider as never });
  cached = { provider, adapter };
  return adapter;
}

/** Reset the cached adapter — call on disconnect or account change. */
export function resetWalletRails(): void {
  cached = null;
}

/** The wallet's Gateway unified balance (confirmed = spendable now). */
export async function walletGatewayBalance(
  provider: Eip1193,
): Promise<{ confirmedMinor: string; pendingMinor: string }> {
  const bal = await ub.getBalance(await adapterFor(provider));
  return { confirmedMinor: bal.confirmedMinor.toString(), pendingMinor: bal.pendingMinor.toString() };
}

/**
 * Spend the wallet's Gateway balance onto Arc, minting to the wallet itself.
 * Sub-second when the balance is confirmed; a just-made deposit is not.
 */
export async function walletSpendToArc(
  provider: Eip1193,
  params: { amountMinor: bigint; recipient: string },
): Promise<string> {
  const adapter = await adapterFor(provider);
  const res = await ub.spend({
    fromAdapter: adapter,
    fromChain: "Ethereum_Sepolia",
    toAdapter: adapter,
    toChain: "Arc_Testnet",
    recipientAddress: params.recipient,
    amountMinor: params.amountMinor,
  });
  return res.txHash;
}

/**
 * Deposit into Gateway from Sepolia. Resolves when the deposit tx is mined, NOT
 * when it is spendable — Gateway credits it only after a safe depth, so the
 * caller must poll `walletGatewayBalance` before spending.
 */
export async function walletGatewayDeposit(provider: Eip1193, amountMinor: bigint): Promise<string> {
  const res = await ub.deposit({
    adapter: await adapterFor(provider),
    chain: "Ethereum_Sepolia",
    amountMinor,
  });
  return res.txHash;
}

/**
 * CCTP bridge Sepolia → Arc into the wallet's own address. Minutes, not seconds,
 * and interruptible: a BridgeStuckError means the burn already happened, so the
 * funds are in flight and it must be resumed, never resent.
 */
export async function walletBridgeToArc(provider: Eip1193, amountMinor: bigint): Promise<string> {
  const adapter = await adapterFor(provider);
  const res = await bridge.execute({
    fromAdapter: adapter,
    fromChain: BridgeChain.Ethereum_Sepolia,
    toAdapter: adapter,
    toChain: BridgeChain.Arc_Testnet,
    amountMinor,
  });
  if (!res.mintTxHash) throw new Error("bridge tak menghasilkan mint");
  return res.mintTxHash;
}
