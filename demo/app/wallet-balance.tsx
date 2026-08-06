"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { useLive } from "./live";

type WalletBalance = {
  /** Arc USDC of the connected wallet, minor units. `null` until read, or on failure. */
  arcUsdc: string | null;
  /** Re-read now — after a transaction, rather than waiting for the next tick. */
  refresh: () => void;
};

const Ctx = createContext<WalletBalance>({ arcUsdc: null, refresh: () => {} });

/**
 * ONE reader of the connected wallet's Arc balance, for the whole app.
 *
 * There were two: the header control polled it every ten seconds, and the
 * market board read it again on connect and after every action — the same
 * address, the same contract, through two separate requests that each had to
 * wait their turn in the Server Action queue. Arc's public RPC starts refusing
 * around the third concurrent call, so the duplicate was not merely wasteful; it
 * was a way to make the number unreadable.
 *
 * Fifteen seconds rather than ten. This is a balance that only changes when the
 * user does something, and the things that change it call `refresh` themselves.
 */
export function WalletBalanceProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const url = isConnected && address ? `/api/wallet?address=${address}&fields=arc` : null;
  const { data, refresh } = useLive<{ arcUsdc: string | null }>(url, null, 15_000);

  // Not `data?.arcUsdc`: after a disconnect the last connected wallet's balance
  // is still in `data`, and showing it next to "no wallet" would be a number
  // belonging to nobody on screen.
  const arcUsdc = url ? data?.arcUsdc ?? null : null;

  return <Ctx.Provider value={{ arcUsdc, refresh }}>{children}</Ctx.Provider>;
}

export const useWalletBalance = () => useContext(Ctx);
