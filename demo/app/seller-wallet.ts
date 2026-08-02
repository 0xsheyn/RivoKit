"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";

const KEY = "rivo.sellerWallet";

/**
 * The seller's own address in two-wallet mode — a second account of the
 * connected wallet that only RECEIVES, so it never has to sign anything.
 *
 * It lives in localStorage because both halves of the demo need it (the Seller
 * panel forwards the floored EURC there, the Withdraw page reads its balance)
 * and they are separate routes with no shared tree. Candidates are every
 * permitted address that is not the connected one — the buyer.
 */
export function useSellerWallet() {
  const { address, addresses } = useAccount();
  const [sellerWallet, setSellerWallet] = useState<string | null>(null);

  useEffect(() => { setSellerWallet(localStorage.getItem(KEY)); }, []);

  const pick = useCallback((a: string | null) => {
    setSellerWallet(a);
    if (a) localStorage.setItem(KEY, a);
    else localStorage.removeItem(KEY);
  }, []);

  const candidates = (addresses ?? []).filter((a) => a.toLowerCase() !== address?.toLowerCase());
  return { sellerWallet, pick, candidates };
}
