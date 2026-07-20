/**
 * Arc Testnet constants.
 *
 * VERIFIED 2026-07-21 against https://docs.arc.io/arc/references/contract-addresses
 * and https://docs.arc.io/arc-chain#network-details.
 *
 * CLAUDE.md §4 requires these to be verified against docs.arc.io rather than
 * hardcoded on trust. Re-verify before each demo: testnet addresses can change,
 * and mainnet addresses do not exist yet.
 */

/** Chain ID. Wallets that report `invalid chain id` are misconfigured. */
export const ARC_TESTNET_CHAIN_ID = 5042002;

export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network";
export const ARC_TESTNET_WS_URL = "wss://rpc.testnet.arc.network";

/**
 * Fallback RPC endpoints, as shipped in viem's `arcTestnet` definition.
 *
 * The public endpoint rate-limits aggressively — long live runs get cut off
 * mid-flight. Rotate through these rather than retrying the same host, and
 * design live scripts to be resumable.
 */
export const ARC_TESTNET_RPC_FALLBACKS = [
  "https://rpc.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network",
] as const;
export const ARC_TESTNET_EXPLORER_URL = "https://testnet.arcscan.app";
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com";

/**
 * Stablecoins. Both use 6 decimals on their ERC-20 interface.
 *
 * USDC is Arc's native gas asset AND an ERC-20 at this address — the same
 * underlying balance seen two ways. The native view uses 18 decimals, the
 * ERC-20 view uses 6, so `1 ERC-20 unit = 1e12 wei`. Never mix the two
 * numerically (CLAUDE.md §0.3). Prefer the ERC-20 interface everywhere.
 */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;
export const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;

/** Both stablecoins: 6 decimals. All money in RivoKit is integer minor units. */
export const TOKEN_DECIMALS = 6;

/** Native gas decimals. Only needed when constructing raw value transfers. */
export const NATIVE_GAS_DECIMALS = 18;

/** Conversion factor between the ERC-20 view (6dp) and the native view (18dp). */
export const NATIVE_PER_ERC20_UNIT = 10n ** 12n;

/** Circle Gateway — chain-abstracted USDC balance. Arc's CCTP domain is 26. */
export const ARC_CCTP_DOMAIN = 26;
export const GATEWAY_WALLET_ADDRESS = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;
export const GATEWAY_MINTER_ADDRESS = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as const;

/** CCTP v2 — used by App Kit's bridge fallback (M2/F2.2). */
export const CCTP_TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;
export const CCTP_MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as const;

/**
 * Permit2 — REQUIRED before any StableFX trade.
 *
 * Arc docs: "Before executing FX trades, StableFX must be able to transfer USDC
 * from your wallet. To enable this, you need to grant a USDC allowance to the
 * Permit2 contract."
 *
 * Note: this prerequisite is absent from the RivoKit planning docs. Phase 2
 * (settlement-fx) must ensure the allowance exists or the floored swap fails
 * before it ever reaches `stopLimit`.
 */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/**
 * StableFX settlement escrow.
 *
 * Recorded for observability/debugging only. RivoKit reaches FX through App Kit
 * Swap (`kit.swap`), NOT by calling this contract directly — see CLAUDE.md §5
 * ("StableFX diakses lewat App Kit Swap, bukan kontrak FxEscrow terpisah").
 */
export const STABLEFX_ESCROW_ADDRESS = "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8" as const;

/**
 * A seeded blocklisted address on Arc Testnet. Any value transfer to or from it
 * reverts at runtime. Use it to exercise revert paths (CLAUDE.md §4 requires the
 * revert/refund path to be tested, not assumed).
 *
 * Derived from the public test mnemonic
 * "test test test test test test test test test test test junk", index 1.
 */
export const BLOCKLISTED_TEST_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

/**
 * viem chain definition.
 *
 * viem >= 2.38 ships `arcTestnet` in `viem/chains`; prefer importing that. This
 * literal exists so non-viem consumers (and the setup script) have one source of
 * truth without pulling viem in.
 */
export const arcTestnet = {
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: NATIVE_GAS_DECIMALS },
  rpcUrls: { default: { http: [ARC_TESTNET_RPC_URL] } },
  blockExplorers: { default: { name: "ArcScan", url: ARC_TESTNET_EXPLORER_URL } },
  testnet: true,
} as const;
