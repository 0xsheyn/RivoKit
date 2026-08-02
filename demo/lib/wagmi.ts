/**
 * Client-side wagmi config for the optional "connect a real wallet" path.
 *
 * The demo defaults to a server-held testnet key (see rivokit.server.ts). When a
 * buyer connects MetaMask instead, they sign the ERC-3009 authorization in their
 * own wallet and the operator relays it — the same gasless collection, but the
 * key never leaves the browser. Arc Testnet only; USDC is Arc's gas token.
 */
import { createConfig, fallback, http } from "wagmi";
import { arcTestnet, avalancheFuji, baseSepolia, sepolia } from "viem/chains";
import { sourceChain } from "./source-chain";

// Connectors come from EIP-6963 injected-provider discovery (MetaMask et al.),
// NOT the wagmi/connectors barrel — that barrel eagerly pulls the Base/Coinbase
// connector and its @coinbase/cdp-sdk → @x402/* optional deps, which aren't
// installed and break the Next build. Discovery covers the demo's MetaMask path.
// Every source chain is here, not just the default: Gateway deposit and the CCTP
// bridge start on whichever one the buyer picks, so the wallet must be able to
// switch to any of them. Arc stays the chain everything settles on. Keep this
// list in step with demo/lib/source-chain.ts.
//
// Transports come from that same table rather than from viem's per-chain
// default. The default for Ethereum Sepolia is a free endpoint that answers
// `403 forbidden` under load, which surfaces as a rail that fails on its first
// call; `fallback` moves to the next endpoint instead.
const srcTransport = (key: Parameters<typeof sourceChain>[0]) =>
  fallback(sourceChain(key).rpcUrls.map((url) => http(url)));

export const wagmiConfig = createConfig({
  chains: [arcTestnet, avalancheFuji, baseSepolia, sepolia],
  transports: {
    [arcTestnet.id]: http(),
    [avalancheFuji.id]: srcTransport("fuji"),
    [baseSepolia.id]: srcTransport("base"),
    [sepolia.id]: srcTransport("sepolia"),
  },
  multiInjectedProviderDiscovery: true,
  ssr: true,
});

export const ARC_CHAIN = arcTestnet;
export const SOURCE_WAGMI_CHAIN = avalancheFuji;
