"use client";

import { useState, useTransition } from "react";
import { RiBankLine, RiCheckboxCircleLine, RiLoader4Line } from "@remixicon/react";
import {
  mintRedeemAction,
  type MintBalanceView,
  type MintDepositView,
  type MintPayoutView,
} from "./mint.actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { withToast } from "./toast";
import { ToneBadge, railTone, statusLabel } from "./_ui";
import { Button } from "@/components/ui/button";
import {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const two = (v: string | number) => Number(v).toFixed(2);
const SYMBOL: Record<string, string> = { EUR: "€", USD: "$" };

/**
 * Circle Mint redemption — the euro-native path's final fiat leg.
 *
 * EUR is the default, and not for cosmetic reasons: Circle exposes a **EUR
 * deposit address on ARC**, so the floored EURC this SDK settles into goes
 * straight from Arc into the Mint balance with no bridge, and out to a SEPA
 * bank. The USD balance has no Arc deposit route at all — redeeming it is a
 * real Circle payout, but it is sandbox money that never touched Arc. This is
 * the exit CPN cannot serve, because CPN only takes USDC as a source currency.
 */
/** `className` is how the withdraw page places this panel on its grid. */
export default function MintRedeem({ className, mint, onDone }: {
  className?: string;
  /** Balances + deposit info, read once with the rest of the page. `null` when
   *  Circle Mint could not be reached — the panel says so instead of looking empty. */
  mint: { balances: MintBalanceView[]; deposit: MintDepositView } | null;
  /** Re-read the page after a redemption, rather than this panel alone. */
  onDone: () => void;
}) {
  const balances = mint?.balances ?? [];
  const deposit = mint?.deposit ?? null;
  const [currency, setCurrency] = useState("EUR");
  const [amount, setAmount] = useState("10");
  const [payout, setPayout] = useState<MintPayoutView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Only the fiat balances Circle can redeem to a bank; the sandbox account also
  // carries oddities like CIRBTC that have nothing to do with this panel.
  const fiat = balances.filter((b) => b.currency === "EUR" || b.currency === "USD");
  const held = fiat.find((b) => b.currency === currency);
  const balNum = held ? Number(held.amount) : 0;
  const amtNum = Number(amount || "0");
  const enough = amtNum > 0 && amtNum <= balNum;
  const sym = SYMBOL[currency] ?? "";

  // Base UI's ToggleGroup reports the whole pressed set; single-select means one
  // entry, and an empty array when the pressed item is clicked again.
  const pickCurrency = ([c]: string[]) => { if (!c) return; setCurrency(c); setPayout(null); setError(null); };

  const redeem = () =>
    start(async () => {
      setError(null);
      const r = await withToast(`Redeeming ${amount} ${currency} to the linked bank`,
        () => mintRedeemAction(amount, currency));
      if (r.ok) { setPayout(r.payout); onDone(); }
      else setError(r.error);
    });

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-bold">
          <RiBankLine className="size-4 text-muted-foreground" />
          Circle Mint — redeem to a bank
        </CardTitle>
        <CardDescription className="truncate">
          The EURC path&apos;s final leg, redeemed 1:1
        </CardDescription>
        <CardAction>
          <span className="text-sm text-muted-foreground">
            <b className="tabular-nums text-foreground">{held ? two(held.amount) : "…"}</b> {currency}
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        <ToggleGroup variant="outline" size="sm" value={[currency]} onValueChange={pickCurrency}>
          {(["EUR", "USD"] as const).map((c) => {
            const b = fiat.find((x) => x.currency === c);
            return (
              <ToggleGroupItem key={c} value={c}>
                {c} <span className="tabular-nums text-muted-foreground">{b ? two(b.amount) : "…"}</span>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>

        {/* Where this balance is topped up from — and for EUR that is Arc itself. */}
        {currency === "EUR" && deposit?.eurOnArc ? (
          <Alert>
            <AlertDescription>
              <span className="font-medium text-foreground">Top up from Arc:</span> send the seller&apos;s EURC to{" "}
              <span className="font-mono text-foreground">
                {deposit.eurOnArc.address.slice(0, 10)}…{deposit.eurOnArc.address.slice(-6)}
              </span>{" "}
              on {deposit.eurOnArc.chain} — no bridge, it credits this EUR balance directly.
            </AlertDescription>
          </Alert>
        ) : deposit?.address ? (
          <Alert>
            <AlertDescription>
              <span className="font-medium text-foreground">Top up:</span> send USDC to{" "}
              <span className="font-mono text-foreground">
                {deposit.address.slice(0, 10)}…{deposit.address.slice(-6)}
              </span>{" "}
              on {deposit.chains.join("/")}. Circle lists no Arc route for USD, so this balance cannot be fed from
              Arc — the EUR one can.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center gap-2">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
            className="flex-1" placeholder="amount" aria-label={`Redeem amount in ${currency}`} />
          <Button size="sm" variant="ghost" onClick={() => setAmount(two(balNum))}>Max</Button>
          <Button size="sm" disabled={pending || !enough} onClick={redeem}>
            {pending ? <RiLoader4Line className="animate-spin" /> : `Redeem ${sym}`}
          </Button>
        </div>
        {amount !== "" && fiat.length > 0 && !enough && (
          <p className="text-sm text-muted-foreground">More than the {currency} balance.</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>

      {payout && (
        <CardFooter className="gap-2 text-sm">
          <RiCheckboxCircleLine className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            Payout {two(payout.amount)} {payout.currency} → {payout.bankName}
            {payout.rail && <> · {payout.rail.toUpperCase()}</>}
          </span>
          <ToneBadge tone={railTone(payout.status)} className="ml-auto">{statusLabel(payout.status)}</ToneBadge>
        </CardFooter>
      )}
    </Card>
  );
}
