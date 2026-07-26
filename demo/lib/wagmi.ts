/**
 * Client-side wagmi config for the optional "connect a real wallet" path.
 *
 * The demo defaults to a server-held testnet key (see rivokit.server.ts). When a
 * buyer connects MetaMask instead, they sign the ERC-3009 authorization in their
 * own wallet and the operator relays it — the same gasless collection, but the
 * key never leaves the browser. Arc Testnet only; USDC is Arc's gas token.
 */
import { createConfig, http } from "wagmi";
import { arcTestnet, sepolia } from "viem/chains";

// Connectors come from EIP-6963 injected-provider discovery (MetaMask et al.),
// NOT the wagmi/connectors barrel — that barrel eagerly pulls the Base/Coinbase
// connector and its @coinbase/cdp-sdk → @x402/* optional deps, which aren't
// installed and break the Next build. Discovery covers the demo's MetaMask path.
// Sepolia is here for the connected wallet's own funding rails: Gateway deposit
// and the CCTP bridge both start there, so the wallet must be able to switch to
// it. Arc stays the chain everything settles on.
export const wagmiConfig = createConfig({
  chains: [arcTestnet, sepolia],
  transports: { [arcTestnet.id]: http(), [sepolia.id]: http() },
  multiInjectedProviderDiscovery: true,
  ssr: true,
});

export const ARC_CHAIN = arcTestnet;
export const SEPOLIA_CHAIN = sepolia;
