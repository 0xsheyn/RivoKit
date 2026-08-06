"use client";

/**
 * Funding rails driven by the CONNECTED wallet, in the browser.
 *
 * The server-signed demo buyer can reach Arc three ways (already on Arc, Gateway
 * unified balance, CCTP bridge from the source chain) because it holds its key.
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
import { createUnifiedBalance, planAllocations } from "../../src/funding/unified-balance.ts";
import { createBridge } from "../../src/funding/bridge.ts";
import {
  ARC_TESTNET_CHAIN_ID, ARC_TESTNET_RPC_FALLBACKS, ARC_TESTNET_EXPLORER_URL,
} from "../../src/constants/arc.ts";
import {
  SOURCE_CHAIN, SOURCE_CHAIN_PARAMS, sourceChainParams, usableSourceChain, type SourceChainId,
} from "../lib/source-chain.ts";
import { hasCode, looksUnrecognizedChain } from "./wallet-errors.ts";

/** USDC on the DEFAULT source chain. Per-chain callers read `sourceChain(id).usdc`. */
export const SOURCE_USDC = SOURCE_CHAIN.usdc;

export type Eip1193 = { request: (args: { method: string; params?: unknown }) => Promise<unknown> };

const hexChain = (id: number) => `0x${id.toString(16)}`;

/**
 * What `wallet_addEthereumChain` needs if the wallet has never seen Arc. Almost
 * no wallet ships Arc Testnet, so a switch to it fails with 4902 until the chain
 * is added — and the source chain now needs the same treatment.
 */
export const ARC_CHAIN_PARAMS = {
  chainId: hexChain(ARC_TESTNET_CHAIN_ID),
  chainName: "Arc Testnet",
  // USDC is the NATIVE gas token on Arc, and it is 18 decimals as gas even
  // though it is 6 as an ERC-20. Getting this wrong makes the wallet show gas
  // costs off by a factor of 1e12.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  // ALL of them, not just the primary. A wallet validates an added chain by
  // calling the RPC itself, and Arc's public endpoint rate-limits hard enough
  // to refuse that call — which the wallet reports as "could not add the
  // network", indistinguishable from a bad config. EIP-3085 takes a list.
  rpcUrls: [...ARC_TESTNET_RPC_FALLBACKS],
  blockExplorerUrls: [ARC_TESTNET_EXPLORER_URL],
} as const;

const kit = new AppKit();
const ub = createUnifiedBalance(kit);
const bridge = createBridge(kit);

/**
 * The only methods that may reach the wallet WITHOUT pinning the chain first.
 *
 * This used to be the opposite — an allowlist of `eth_sendTransaction` and
 * `eth_signTransaction` — and that was wrong in a way no unit test caught:
 * Gateway's burn intent is signed with `eth_signTypedData_v4`, which was not on
 * the list. A wallet REFUSES to sign typed data whose `domain.chainId` is not
 * the chain it is on, and it refuses without prompting — so the user saw an
 * error and never got the switch prompt at all. Reads have the same problem
 * more quietly: an `eth_call` or `eth_estimateGas` answered by the wrong chain
 * returns a confident wrong answer.
 *
 * A denylist is the honest shape: a view pinned to a chain should behave as
 * that chain for everything except the calls that would recurse (chain
 * queries and the switch/add pair) or that are chain-independent by nature
 * (account and permission plumbing).
 */
const CHAIN_FREE = new Set([
  "eth_chainId",
  "net_version",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "eth_accounts",
  "eth_requestAccounts",
  "wallet_getPermissions",
  "wallet_requestPermissions",
  "wallet_revokePermissions",
  "web3_clientVersion",
]);

/**
 * The user declined a network prompt.
 *
 * Its own type because the UI has to treat it differently from a failure:
 * nothing is broken, nothing was signed, and the correct response is to ask
 * again rather than to report an error. EIP-1193 signals it as code 4001.
 */
export class WalletChainRejected extends Error {
  readonly code = "WALLET_CHAIN_REJECTED";
  readonly action: "switch" | "add";

  constructor(chainLabel: string, action: "switch" | "add") {
    super(
      action === "add"
        ? `The wallet was not allowed to add ${chainLabel}. Nothing was signed — approve the network to continue.`
        : `The wallet was not allowed to switch to ${chainLabel}. Nothing was signed — approve the network switch to continue.`,
    );
    this.name = "WalletChainRejected";
    this.action = action;
  }
}

/**
 * A view of one wallet pinned to one chain.
 *
 * A cross-chain move needs two adapters — a burn on the source, a mint on the
 * destination — but a browser wallet is ONE object sitting on ONE chain at a
 * time. `createViemAdapterFromProvider` takes no chain argument and derives it
 * from the provider, so handing the same adapter to both sides of a spend makes
 * App Kit attempt the destination transaction on the source chain. That is not
 * hypothetical: it failed live with "The current chain of the wallet (id:
 * 11155111) does not match the target chain (id: 5042002)" — AFTER the burn had
 * already landed, leaving the funds in flight.
 *
 * This wrapper makes one provider look like two. Each pinned view reports its
 * own chain and, before it signs anything, asks the wallet to switch. Real
 * wallets prompt the user at that moment, which is the correct experience: you
 * cannot silently sign an Arc transaction from a wallet showing Sepolia.
 *
 * The chain is re-checked on every write rather than remembered — the two views
 * share one wallet, so whatever the other view last switched to is exactly what
 * a cached answer would get wrong.
 */
export function pinnedTo(provider: Eip1193, chainId: number, addParams?: Record<string, unknown>): Eip1193 {
  const wanted = hexChain(chainId);
  const label = (addParams?.["chainName"] as string) ?? `chain ${chainId}`;

  async function ensureChain(): Promise<void> {
    const current = await provider.request({ method: "eth_chainId" });
    if (typeof current === "string" && current.toLowerCase() === wanted.toLowerCase()) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wanted }] });
    } catch (e) {
      // 4001 = the user said no. That is a decision, not a fault, and it must
      // surface as something a UI can show — a raw wallet error here reads as a
      // crash for what is really "please approve the network switch". Only the
      // code counts here: calling a genuine fault a "decision" would be worse
      // than the reverse, so there is deliberately no message fallback.
      if (hasCode(e, 4001)) throw new WalletChainRejected(label, "switch");
      // 4902 = the wallet does not know this chain. Adding it is the documented
      // recovery (EIP-3085), and almost no wallet ships Arc Testnet.
      if ((hasCode(e, 4902) || looksUnrecognizedChain(e)) && addParams) {
        try {
          await provider.request({ method: "wallet_addEthereumChain", params: [addParams] });
        } catch (addErr) {
          if (hasCode(addErr, 4001)) throw new WalletChainRejected(label, "add");
          throw addErr;
        }
        // Adding usually switches too, but the spec does not promise it — so
        // confirm rather than assume, or the write below runs on the old chain
        // and fails the way this whole wrapper exists to prevent.
        const after = await provider.request({ method: "eth_chainId" });
        if (typeof after === "string" && after.toLowerCase() === wanted.toLowerCase()) return;
        try {
          await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wanted }] });
        } catch (switchErr) {
          if (hasCode(switchErr, 4001)) throw new WalletChainRejected(label, "switch");
          throw switchErr;
        }
        return;
      }
      throw e;
    }
  }

  return {
    async request(args) {
      // Answered from the pin, not the wallet: this view IS that chain, and the
      // wallet may currently be sitting on the other one.
      if (args.method === "eth_chainId") return wanted;
      if (args.method === "net_version") return String(chainId);
      if (!CHAIN_FREE.has(args.method)) await ensureChain();
      return provider.request(args);
    },
  };
}

// One adapter per (provider, chain): building it hits the wallet, and App Kit
// caches its own clients behind it.
const cache = new Map<Eip1193, Map<number, Promise<unknown>>>();

function adapterFor(provider: Eip1193, chainId: number, addParams?: Record<string, unknown>): Promise<unknown> {
  let perChain = cache.get(provider);
  if (!perChain) {
    perChain = new Map();
    cache.set(provider, perChain);
  }
  let adapter = perChain.get(chainId);
  if (!adapter) {
    adapter = createViemAdapterFromProvider({ provider: pinnedTo(provider, chainId, addParams) as never });
    perChain.set(chainId, adapter);
  }
  return adapter;
}

// One adapter per source chain, so a wallet holding USDC on Base and on Fuji
// can fund from either without the two views colliding — `adapterFor` already
// keys its cache by chain id.
// `usableSourceChain`, not `sourceChain`: this is the single chokepoint every
// money-moving wallet rail passes through (bridge, Gateway deposit, spend), so
// refusing a disabled chain here covers all of them at once — and refuses BEFORE
// the wallet is asked to switch chains or approve anything.
const sourceAdapter = (p: Eip1193, from?: SourceChainId) => {
  const c = usableSourceChain(from);
  return adapterFor(p, c.id, sourceChainParams(c) as never);
};
const arcAdapter = (p: Eip1193) => adapterFor(p, ARC_TESTNET_CHAIN_ID, ARC_CHAIN_PARAMS as never);

/** Reset the cached adapters — call on disconnect or account change. */
export function resetWalletRails(): void {
  cache.clear();
}

/**
 * The wallet's Gateway unified balance (confirmed = spendable now), with the
 * per-chain split the spend below actually allocates against.
 *
 * The total is chain-abstracted; a spend is not. Both are returned because both
 * are true and they answer different questions: the total is what the payer
 * owns, `byChain` is what a burn intent can name.
 */
export async function walletGatewayBalance(
  provider: Eip1193,
): Promise<{
  confirmedMinor: string;
  pendingMinor: string;
  byChain: Array<{ chain: string; confirmedMinor: string; pendingMinor: string }>;
}> {
  const bal = await ub.getBalance(await sourceAdapter(provider));
  return {
    confirmedMinor: bal.confirmedMinor.toString(),
    pendingMinor: bal.pendingMinor.toString(),
    byChain: bal.byChain.map((b) => ({
      chain: b.chain,
      confirmedMinor: b.confirmedMinor.toString(),
      pendingMinor: b.pendingMinor.toString(),
    })),
  };
}

/**
 * Spend the wallet's Gateway balance onto Arc, minting to the wallet itself.
 * Sub-second when the balance is confirmed; a just-made deposit is not.
 *
 * The source chain the payer picked is a PREFERENCE, not the whole plan. It used
 * to be the whole plan — one allocation, pinned to that chain — and the result
 * was a rail that failed with "Insufficient USDC balance on Ethereum Sepolia.
 * Available: 0 USDC" on a wallet whose Gateway balance was sitting on Fuji, in
 * the same total the UI was showing as available. `planAllocations` reads where
 * the money actually is and draws the preferred chain down first.
 */
export async function walletSpendToArc(
  provider: Eip1193,
  params: { amountMinor: bigint; recipient: string; from?: SourceChainId },
): Promise<string> {
  // Two adapters, one wallet. The burn is authorized on the source chain and the
  // mint is sent on Arc, so each side needs a view pinned to its own chain — see
  // `pinnedTo` for what passing a single adapter here actually cost.
  const fromAdapter = await sourceAdapter(provider, params.from);
  const balance = await ub.getBalance(fromAdapter);
  const res = await ub.spend({
    fromAdapter,
    allocations: planAllocations(balance.byChain, params.amountMinor, {
      prefer: usableSourceChain(params.from).name,
    }),
    toAdapter: await arcAdapter(provider),
    toChain: "Arc_Testnet",
    recipientAddress: params.recipient,
    amountMinor: params.amountMinor,
  });
  return res.txHash;
}

/**
 * Deposit into Gateway from the source chain. Resolves when the deposit tx is
 * mined, NOT when it is spendable — Gateway credits it only after a safe depth,
 * so the caller must poll `walletGatewayBalance` before spending.
 */
export async function walletGatewayDeposit(
  provider: Eip1193,
  amountMinor: bigint,
  from?: SourceChainId,
): Promise<string> {
  const res = await ub.deposit({
    adapter: await sourceAdapter(provider, from),
    chain: usableSourceChain(from).name,
    amountMinor,
  });
  return res.txHash;
}

/**
 * CCTP bridge source chain → Arc, into the wallet's own address.
 *
 * Roughly a minute from any of the four: App Kit defaults to CCTP v2 Fast
 * Transfer (`transferSpeed ?? TransferSpeed.FAST`), whose threshold is 1-2
 * blocks on Fuji/Base/Sepolia and 13 on Amoy — still seconds — and the wallet
 * prompts cost more than the attestation. A spent Fast Transfer Allowance drops
 * Base and Ethereum Sepolia to 65 confirmations and Amoy to 33 — see
 * demo/lib/source-chain.ts.
 *
 * Interruptible either way: a BridgeStuckError means the burn already happened,
 * so the funds are in flight and it must be resumed, never resent. That property
 * is a function of CCTP, not of which chain it starts on.
 */
export async function walletBridgeToArc(
  provider: Eip1193,
  amountMinor: bigint,
  from?: SourceChainId,
): Promise<string> {
  const res = await bridge.execute({
    fromAdapter: await sourceAdapter(provider, from),
    fromChain: usableSourceChain(from).name as BridgeChain,
    toAdapter: await arcAdapter(provider),
    toChain: BridgeChain.Arc_Testnet,
    amountMinor,
  });
  if (!res.mintTxHash) throw new Error("bridge produced no mint");
  return res.mintTxHash;
}
