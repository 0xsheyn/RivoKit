"use client";

import { useEffect, useState } from "react";
import { RiArrowRightLine, RiHistoryLine } from "@remixicon/react";
import { cpnHistoryAction, type CashoutRow } from "./ramp.actions";
import { mintHistoryAction, type MintPayoutView } from "./mint.actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, ToneBadge, railTone, statusLabel } from "./_ui";

/** "31 Jul 14:05" — enough to tell two runs of the same amount apart. */
const when = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** Shared shell so both histories read as one thing in two columns. */
function HistoryCard({ title, className, children }: {
  // `| undefined` spelled out because the project runs `exactOptionalPropertyTypes`
  // and both callers forward a prop that may legitimately be absent.
  title: string; className?: string | undefined; children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-bold">
          <RiHistoryLine className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">{children}</CardContent>
    </Card>
  );
}

function Row({ left, right, meta, status }: {
  left: React.ReactNode; right: React.ReactNode; meta?: React.ReactNode;
  status: string;
}) {
  return (
    // One step tighter than the Card that holds it (`rounded-4xl`), so the rows
    // read as nested inside the panel instead of competing with its edge.
    <div className="rounded-2xl border px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
          <span className="truncate">{left}</span>
          <RiArrowRightLine className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{right}</span>
        </span>
        <ToneBadge tone={railTone(status)} className="ml-auto">{statusLabel(status)}</ToneBadge>
      </div>
      {meta && <div className="mt-1 truncate text-xs text-muted-foreground">{meta}</div>}
    </div>
  );
}

/**
 * Every CPN payment this demo has made, from either direction: the automatic
 * payout at the end of a bank-bound order's `release()`, and the manual
 * cash-out from the panel above. Both spend the seller's USDC through the same
 * corridor, so listing them apart would suggest they are different products.
 *
 * `orderId` is the discriminator, and it is structural rather than a flag we
 * set: only the release path knows an order, so a row carrying one came from a
 * release and a row without one was triggered by hand.
 *
 * Polled rather than pushed from the panel above: a webhook (or the reconcile
 * sweep) can move a row long after the tab stopped acting on it, and a history
 * that only knew what this tab did would go stale silently.
 */
export function CpnHistory({ className }: { className?: string }) {
  const [rows, setRows] = useState<CashoutRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const read = () => cpnHistoryAction().then((r) => {
      if (r.ok) { setRows(r.rows); setError(null); } else setError(r.error);
    });
    read();
    const id = setInterval(read, 20_000);
    return () => clearInterval(id);
  }, []);

  return (
    <HistoryCard title="All payment history" className={className}>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {rows?.length === 0 && <Empty className="text-xs">No payment yet.</Empty>}
      {rows?.map((r) => (
        <Row key={r.paymentId} status={r.status}
          left={`${r.source} ${r.sourceCurrency}`}
          right={`${r.destination} ${r.destinationCurrency}`}
          meta={
            <>
              {r.corridor} · signed by {r.signedBy} · {when(r.createdAt)}
              {" · "}
              <span className="font-semibold text-foreground">{r.orderId ? "Payout" : "Cashout"}</span>
              {r.orderId && <> · order <span className="font-mono">{r.orderId}</span></>}
              {r.failureReason && <span className="text-destructive"> · {r.failureReason}</span>}
            </>
          } />
      ))}
    </HistoryCard>
  );
}

/** Past Circle Mint redemptions, read back from Circle on every poll. */
export function MintHistory({ className }: { className?: string }) {
  const [rows, setRows] = useState<MintPayoutView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const read = () => mintHistoryAction().then((r) => {
      if (r.ok) { setRows(r.payouts); setError(null); } else setError(r.error);
    });
    read();
    const id = setInterval(read, 20_000);
    return () => clearInterval(id);
  }, []);

  return (
    <HistoryCard title="Redemption history · Circle Mint" className={className}>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {rows?.length === 0 && <Empty className="text-xs">No redemption yet.</Empty>}
      {rows?.map((p) => (
        <Row key={p.id} status={p.status}
          left={`${Number(p.amount).toFixed(2)} ${p.currency}`}
          right={p.bankName}
          meta={<>{when(p.createdAt)} · <span className="font-mono">{p.id.slice(0, 8)}…</span></>} />
      ))}
    </HistoryCard>
  );
}
