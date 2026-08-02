/**
 * The chains the demo's cross-chain rails can START from.
 *
 * Both rails — the CCTP bridge and the Gateway unified balance — take a source
 * chain, and the buyer picks it. The table lives here rather than inline in each
 * caller because the browser path (`demo/app/wallet-rails.ts`) and the server
 * path (`demo/lib/rivokit.server.ts`) must agree; a mismatch would let the UI
 * read a balance on one chain while the burn happens on another.
 *
 * Every field below is taken from Circle's own chain table
 * (`@circle-fin/adapter-circle-wallets`), not hand-copied from documentation —
 * chain ids, USDC addresses and finality depths all come from there.
 *
 * ── How long a bridge actually takes ──────────────────────────────────────────
 *
 * CCTP waits for the SOURCE chain to reach a finality threshold before Circle
 * signs the attestation, and that wait is the whole cost of a bridge. There are
 * two thresholds, and which one applies is the difference between seconds and a
 * quarter of an hour. From Circle's chain table, for CCTP **v2**:
 *
 *                      fastConfirmations      confirmations (hard finality)
 *   Avalanche Fuji             1                      1
 *   Base Sepolia               1                     65   (~15-19 min)
 *   Ethereum Sepolia           2                     65   (~15-19 min)
 *   Polygon Amoy              13                     33   (~1-2 min)
 *
 * Arc Testnet publishes **only** a v2 CCTP deployment, so every transfer here is
 * v2 — the version that has Fast Transfer at all. And App Kit defaults to it:
 * `transferSpeed: params.config?.transferSpeed ?? TransferSpeed.FAST`. RivoKit
 * passes no `transferSpeed`, so all four chains normally settle in seconds.
 *
 * Fast Transfer is not free: Circle charges a few bps for it, and it draws on a
 * Fast Transfer Allowance that can be exhausted. When it is, the transfer falls
 * back to hard finality — which costs Base and Ethereum ~15-19 minutes, costs
 * Amoy a minute or two (33 confirmations at ~2s blocks), and costs Fuji nothing,
 * because its hard finality is already 1 confirmation.
 *
 * That, and only that, is why Fuji is the default: it is the one chain whose
 * worst case equals its best case. The others are offered because a payer holds
 * USDC where they hold it — the point of a multichain funding story.
 *
 * To add another chain, add a row. The `name` must exist in App Kit's
 * `BridgeChain` AND in `UnifiedBalanceChain`; all four below do.
 */
export type SourceChainId = "fuji" | "base" | "sepolia" | "amoy";

export type SourceChain = {
  /** Stable key used by the UI and the server actions. */
  key: SourceChainId;
  /** EVM chain id — what the wallet is asked to switch to. */
  id: number;
  /** App Kit's identifier, shared by BridgeChain and UnifiedBalanceChain. */
  name: string;
  /** For UI copy. */
  label: string;
  /** USDC on this chain, from Circle's chain table. */
  usdc: string;
  /**
   * More than one, in preference order, and never left to a library default.
   *
   * A free public endpoint answers `403 forbidden` the moment it decides it
   * dislikes the caller — observed on `1rpc.io/sepolia` for a plain
   * `eth_getTransactionCount` — and a single-endpoint transport turns that into
   * a dead rail. This is the same treatment Arc already gets
   * (`ARC_TESTNET_RPC_FALLBACKS`), for the same reason.
   *
   * The first entry is the one Circle's own chain table names — EXCEPT on Amoy,
   * where that endpoint does not resolve here at all; see the row's own note.
   */
  rpcUrls: readonly string[];
  explorerUrl: string;
  /**
   * Gas here is the chain's own native token, NOT USDC — unlike Arc, where USDC
   * is the native token. A buyer with USDC but no gas cannot use this rail.
   */
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /**
   * How long the CCTP attestation makes the buyer wait, on the Fast path App Kit
   * takes by default — and what it degrades to if the Fast allowance is spent.
   * Shown in the rail list, so it must describe the NORMAL case first.
   */
  finality: string;
  /**
   * Set when the rail is known NOT to work, with the reason in the buyer's own
   * terms. The row stays in the table — it is kept, not deleted, so the work to
   * finish it survives — but nothing may start a transfer from it.
   *
   * A disabled chain is still SHOWN, greyed out and unselectable, rather than
   * hidden: a chain that silently vanishes reads as a bug, and the balance a
   * payer holds there is still worth showing them.
   */
  disabledReason?: string;
};

export const SOURCE_CHAINS: readonly SourceChain[] = [
  {
    key: "fuji",
    id: 43113,
    name: "Avalanche_Fuji",
    label: "Avalanche Fuji",
    usdc: "0x5425890298aed601595a70ab815c96711a31bc65",
    rpcUrls: [
      "https://api.avax-test.network/ext/bc/C/rpc",
      "https://avalanche-fuji-c-chain-rpc.publicnode.com",
    ],
    explorerUrl: "https://testnet.snowtrace.io",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    finality: "~seconds — 1 confirmation either way",
  },
  {
    key: "base",
    id: 84532,
    name: "Base_Sepolia",
    label: "Base Sepolia",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpcUrls: [
      "https://sepolia.base.org",
      "https://base-sepolia-rpc.publicnode.com",
    ],
    explorerUrl: "https://sepolia.basescan.org",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    finality: "~seconds (fast) · ~15-19 min if the fast allowance is spent",
  },
  {
    key: "sepolia",
    id: 11155111,
    name: "Ethereum_Sepolia",
    label: "Ethereum Sepolia",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    rpcUrls: [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://sepolia.drpc.org",
    ],
    explorerUrl: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    finality: "~seconds (fast, 2 blocks) · ~15-19 min if the fast allowance is spent",
  },
  {
    key: "amoy",
    id: 80002,
    name: "Polygon_Amoy_Testnet",
    label: "Polygon Amoy",
    usdc: "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582",
    // Circle's chain table names `rpc-amoy.polygon.technology` first, and it is
    // the one endpoint here that does NOT resolve on this network — plain
    // ENOTFOUND, verified 2026-08-02, the same treatment `*.circle.com` gets.
    // So it is kept (it is the canonical one, and it works elsewhere) but demoted
    // below two that were read live: both answered at block ~43,854,600.
    rpcUrls: [
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://polygon-amoy.drpc.org",
      "https://rpc-amoy.polygon.technology",
    ],
    explorerUrl: "https://amoy.polygonscan.com",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    finality: "~seconds (fast, 13 blocks) · ~1-2 min if the fast allowance is spent",
    // Approve lands, then the CCTP burn reverts every time — simulation fails
    // with EMPTY revert data inside App Kit's `kitContracts.bridge` wrapper.
    // Proven to be Amoy's own problem, not ours: the identical code path from
    // Ethereum Sepolia → Arc completes end-to-end (burn 0xf3504eab…, mint
    // 0xb1dc1f20…, 2026-08-02). Ruled out as causes: gas, allowance, balance,
    // destination (domain 0 and 6 revert the same), the wrapper deployment
    // (identical 813-byte bytecode on four chains, not paused), token identity,
    // burn limits, `maxFee`, and `transferSpeed`. `estimateBridge` SUCCEEDS on
    // this route — which is exactly why it must be blocked here instead: nothing
    // upstream reports it as broken. See scripts/live-bridge-amoy.mjs.
    disabledReason: "CCTP burn reverts from Amoy — approve lands, the burn never does",
  },
] as const;

export const DEFAULT_SOURCE_CHAIN_ID: SourceChainId = "fuji";

/** The default source chain. Kept as a named export: scripts import it directly. */
export const SOURCE_CHAIN: SourceChain = SOURCE_CHAINS[0]!;

/** The rows a payer may actually transfer from. The UI still renders the rest, greyed out. */
export const ENABLED_SOURCE_CHAINS: readonly SourceChain[] = SOURCE_CHAINS.filter((c) => !c.disabledReason);

/** Never throws — an unknown key falls back to the default rather than breaking a rail. */
export function sourceChain(key: string | null | undefined): SourceChain {
  return SOURCE_CHAINS.find((c) => c.key === key) ?? SOURCE_CHAIN;
}

/**
 * The same lookup, for the code paths that are about to MOVE money.
 *
 * Throws rather than falling back to the default, which is the whole point: a
 * silent substitution here would approve on the chain the payer picked and burn
 * on a different one. Loud refusal beats a transfer nobody asked for.
 */
export function usableSourceChain(key: string | null | undefined): SourceChain {
  const c = sourceChain(key);
  if (c.disabledReason) {
    throw new Error(`Source chain ${c.label} is disabled: ${c.disabledReason}`);
  }
  return c;
}

/** Reverse lookup by App Kit chain name — for turning a recorded tx into an explorer link. */
export function sourceChainByName(name: string | null | undefined): SourceChain | undefined {
  return SOURCE_CHAINS.find((c) => c.name === name);
}

/**
 * `wallet_addEthereumChain` params, for a wallet that has never seen this chain.
 * MetaMask ships Ethereum Sepolia but not Fuji, so a switch fails with 4902
 * until the chain is added — the same recovery Arc Testnet needs.
 *
 * ALL the endpoints go in, not just the first: a wallet validates an added chain
 * by calling the RPC itself, and one endpoint answering 403 reads to the user as
 * "could not add the network". EIP-3085 takes a list.
 */
export function sourceChainParams(c: SourceChain) {
  return {
    chainId: `0x${c.id.toString(16)}`,
    chainName: c.label,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: [...c.rpcUrls],
    blockExplorerUrls: [c.explorerUrl],
  } as const;
}

export const SOURCE_CHAIN_PARAMS = sourceChainParams(SOURCE_CHAIN);
