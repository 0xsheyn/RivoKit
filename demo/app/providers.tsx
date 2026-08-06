"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "../lib/wagmi";
import { WalletBalanceProvider } from "./wallet-balance";

/**
 * Wraps the app so the optional connect-wallet path has wagmi + react-query.
 *
 * `WalletBalanceProvider` sits inside them because it needs `useAccount`, and
 * above everything else because the header and the market board both read the
 * connected wallet's balance — one poll, two readers.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletBalanceProvider>{children}</WalletBalanceProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
