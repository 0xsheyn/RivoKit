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
function HistoryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
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
    <div className="border px-2.5 py-2">
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
 * Past CPN cash-outs. Polled rather than pushed from the panel above: a webhook
 * (or the reconcile sweep) can move a row long after the tab stopped acting on
 * it, and a history that only knew what this tab did would go stale silently.
 */
export function CpnHistory() {
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
    <HistoryCard title="Cash-out history · CPN">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {rows?.length === 0 && <Empty>No cash-out yet.</Empty>}
      {rows?.map((r) => (
        <Row key={r.paymentId} status={r.status}
          left={`${r.source} ${r.sourceCurrency}`}
          right={`${r.destination} ${r.destinationCurrency}`}
          meta={
            <>
              {r.corridor} · signed by {r.signedBy} · {when(r.createdAt)}
              {r.orderId && <> · order <span className="font-mono">{r.orderId}</span></>}
              {r.failureReason && <span className="text-destructive"> · {r.failureReason}</span>}
            </>
          } />
      ))}
    </HistoryCard>
  );
}

/** Past Circle Mint redemptions, read back from Circle on every poll. */
export function MintHistory() {
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
    <HistoryCard title="Redemption history · Circle Mint">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {rows?.length === 0 && <Empty>No redemption yet.</Empty>}
      {rows?.map((p) => (
        <Row key={p.id} status={p.status}
          left={`${Number(p.amount).toFixed(2)} ${p.currency}`}
          right={p.bankName}
          meta={<>{when(p.createdAt)} · <span className="font-mono">{p.id.slice(0, 8)}…</span></>} />
      ))}
    </HistoryCard>
  );
}
