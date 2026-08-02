"use client";

import { useState } from "react";
import { isAddress } from "viem";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Eip1193 } from "./wallet-rails";

/**
 * Choosing the seller's address, in the three ways a user actually has one.
 *
 * The seller only RECEIVES — no signature, ever — so it does not have to be an
 * account this wallet controls, and pasting an address is a legitimate answer
 * rather than an escape hatch. The other two paths exist because the wallet's
 * permitted-accounts list is the thing most people cannot find: `candidates`
 * are the accounts already permitted, and "Permit another account" opens the
 * wallet's own account picker (EIP-2255) instead of telling the user where to
 * click in MetaMask.
 */
export default function SellerWalletPicker({
  candidates,
  onPick,
}: {
  candidates: readonly string[];
  onPick: (address: string) => void;
}) {
  const { connector, isConnected, address } = useAccount();
  const [manual, setManual] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = manual.trim();
  const valid = isAddress(trimmed);
  const isSelf = valid && trimmed.toLowerCase() === address?.toLowerCase();

  /**
   * Ask the wallet to permit another account. wagmi picks the new list up from
   * the `accountsChanged` event, so nothing here has to refetch.
   */
  const permitAnother = async () => {
    setError(null);
    setAsking(true);
    try {
      const provider = (await connector?.getProvider?.()) as Eip1193 | undefined;
      if (!provider) throw new Error("Wallet provider unavailable");
      await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    } catch (e) {
      // Rejecting the prompt is a normal answer, not a failure worth shouting about.
      const msg = e instanceof Error ? e.message : String(e);
      setError(/reject|denied|4001/i.test(msg) ? null : msg);
    }
    setAsking(false);
  };

  return (
    <div className="flex flex-col gap-2">
      {candidates.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((a) => (
            <Button key={a} variant="outline" size="sm" className="font-mono" onClick={() => onPick(a)}>
              {a.slice(0, 6)}…{a.slice(-4)}
            </Button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input value={manual} onChange={(e) => setManual(e.target.value)} spellCheck={false}
          className="flex-1 font-mono text-xs" placeholder="0x… paste any address"
          aria-label="Seller wallet address" />
        <Button size="sm" disabled={!valid || isSelf} onClick={() => { onPick(trimmed); setManual(""); }}>
          Use
        </Button>
      </div>

      {isConnected && (
        <Button size="sm" variant="ghost" className="self-start" disabled={asking} onClick={permitAnother}>
          {asking ? "Waiting for the wallet…" : "Permit another account from my wallet"}
        </Button>
      )}

      <p className="text-xs text-muted-foreground">
        {trimmed !== "" && !valid
          ? "Not a valid address."
          : isSelf
            ? "That is the connected (buyer) address — pick a different one."
            : error
              ? error
              : "The seller only receives, so any address works — it never signs anything."}
      </p>
    </div>
  );
}
