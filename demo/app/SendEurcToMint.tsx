"use client";

import { useState } from "react";
import { RiArrowRightLine, RiExternalLinkLine, RiLoader4Line, RiSendPlaneLine } from "@remixicon/react";
import { erc20Abi, isAddress, parseUnits } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import type { MintDepositView } from "./mint.actions";
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_EXPLORER_URL, EURC_ADDRESS } from "../../src/constants/arc";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { shortAddr, shortHash, usd } from "./_ui";
import { walletErrorMessage } from "./wallet-errors";
import { withToast } from "./toast";

/**
 * The one exit the floored EURC actually has.
 *
 * CPN takes USDC and only USDC, so the EURC a wallet-bound order settles into
 * cannot be cashed out through it at all. Circle Mint can: it publishes a EUR
 * deposit address **on Arc**, so the seller's EURC walks straight in with no
 * bridge, and the redeem on the panel beside this one takes it to a SEPA bank.
 *
 * The transfer is signed by the wallet that HOLDS the EURC — no server key
 * participates, and none could: this is the seller's own money moving out of
 * the seller's own wallet.
 */
export default function SendEurcToMint({
  sellerWallet,
  balanceMinor,
  deposit,
  onSent,
}: {
  sellerWallet: string | null;
  balanceMinor: string | null;
  /** Handed down rather than fetched: MintRedeem was already asking Circle for
   *  exactly this, and two components asking the same question is two requests
   *  the Server Action queue ran one after the other. */
  deposit: MintDepositView | null;
  onSent: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<null | "switch" | "send" | "wait">(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { address, isConnected, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: ARC_TESTNET_CHAIN_ID });

  const target = deposit?.eurOnArc?.address ?? null;
  const held = balanceMinor == null ? 0 : Number(balanceMinor) / 1e6;
  const amt = Number(amount || "0");
  // The wallet can only spend its OWN balance, and a browser wallet cannot be
  // switched to another account programmatically — so this is a precondition to
  // state plainly, not a check to hide.
  const isHolder = Boolean(address && sellerWallet && address.toLowerCase() === sellerWallet.toLowerCase());
  const enough = amt > 0 && amt <= held;

  const send = async () => {
    if (!target || !isAddress(target) || !publicClient) return;
    setError(null);
    setTxHash(null);
    try {
      if (chainId !== ARC_TESTNET_CHAIN_ID) {
        setBusy("switch");
        await switchChainAsync({ chainId: ARC_TESTNET_CHAIN_ID });
      }
      setBusy("send");
      const hash = await withToast(`Sending ${amount} EURC to the Mint deposit address`, () =>
        writeContractAsync({
          address: EURC_ADDRESS,
          abi: erc20Abi,
          functionName: "transfer",
          args: [target as `0x${string}`, parseUnits(amount, 6)],
          chainId: ARC_TESTNET_CHAIN_ID,
        }));
      setTxHash(hash);
      setBusy("wait");
      await withToast("Waiting for the transfer to be mined on Arc", () =>
        publicClient.waitForTransactionReceipt({ hash }));
      setAmount("");
      onSent();
    } catch (e) {
      setError(walletErrorMessage(e, "Transfer declined in wallet — nothing was sent."));
    }
    setBusy(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-bold">
          <RiSendPlaneLine className="size-4 text-muted-foreground" />
          Send EURC → Circle Mint
        </CardTitle>
        <CardDescription className="truncate">
          Arc → the Mint EUR balance, no bridge — then redeem it beside this
        </CardDescription>
        <CardAction>
          <span className="text-sm text-muted-foreground">
            <b className="tabular-nums text-foreground">{usd(balanceMinor)}</b> EURC
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {target ? (
          <p className="text-sm text-muted-foreground">
            Deposit address{" "}
            <span className="font-mono text-foreground">{shortAddr(target)}</span> on{" "}
            {deposit?.eurOnArc?.chain}. CPN cannot take EURC at all, so this is the only exit it has.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Circle lists no EUR deposit address on Arc for this account — without one there is nothing to send to.
          </p>
        )}

        {!isConnected ? (
          <Alert>
            <AlertDescription>Connect the wallet holding the EURC to send it.</AlertDescription>
          </Alert>
        ) : !sellerWallet ? (
          <Alert>
            <AlertDescription>Pick a seller wallet above first — that is the balance this sends.</AlertDescription>
          </Alert>
        ) : !isHolder ? (
          <Alert>
            <AlertDescription>
              The EURC sits in <span className="font-mono text-foreground">{shortAddr(sellerWallet)}</span>, but{" "}
              <span className="font-mono text-foreground">{shortAddr(address!)}</span> is the active account. Only the
              holder can sign this transfer — switch accounts in your wallet.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center gap-2">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
            className="flex-1" placeholder="EURC amount" aria-label="EURC amount to send" />
          <Button size="sm" variant="ghost" disabled={held <= 0} onClick={() => setAmount(held.toFixed(2))}>
            Max
          </Button>
          <Button size="sm" disabled={!target || !isHolder || !enough || busy !== null} onClick={send}>
            {busy === null ? "Send" : <RiLoader4Line className="animate-spin" />}
          </Button>
        </div>
        {busy && (
          <p className="text-sm text-muted-foreground">
            {busy === "switch" ? "Waiting for the network switch…"
              : busy === "send" ? "Waiting for the signature…"
                : "Waiting for the transaction to be mined…"}
          </p>
        )}
        {amount !== "" && !enough && balanceMinor != null && (
          <p className="text-sm text-muted-foreground">More than the seller wallet holds.</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>

      {txHash && (
        <CardFooter className="gap-2 text-sm">
          <span className="truncate">Sent — Circle credits the EUR balance asynchronously.</span>
          <a href={`${ARC_TESTNET_EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-mono text-primary underline-offset-4 hover:underline">
            {shortHash(txHash)}
            <RiExternalLinkLine className="size-3" />
          </a>
        </CardFooter>
      )}
    </Card>
  );
}
