/**
 * Client-side wagmi config for the optional "connect a real wallet" path.
 *
 * The demo defaults to a server-held testnet key (see rivokit.server.ts). When a
 * buyer connects MetaMask instead, they sign the ERC-3009 authorization in their
 * own wallet and the operator relays it — the same gasless collection, but the
 * key never leaves the browser. Arc Testnet only; USDC is Arc's gas token.
 */
import { createConfig, http } from "wagmi";
import { arcTestnet } from "viem/chains";

// Connectors come from EIP-6963 injected-provider discovery (MetaMask et al.),
// NOT the wagmi/connectors barrel — that barrel eagerly pulls the Base/Coinbase
// connector and its @coinbase/cdp-sdk → @x402/* optional deps, which aren't
// installed and break the Next build. Discovery covers the demo's MetaMask path.
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  transports: { [arcTestnet.id]: http() },
  multiInjectedProviderDiscovery: true,
  ssr: true,
});

export const ARC_CHAIN = arcTestnet;
