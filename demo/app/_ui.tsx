"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/* ── format ──────────────────────────────────────────────────────────────── */

/** "12.34" from micro-units; em dash when unknown. */
export const usd = (m: string | null | undefined) => (m == null ? "—" : (Number(m) / 1e6).toFixed(2));
export const num = (m: string | null | undefined) => (m == null ? 0 : Number(m) / 1e6);
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

/* ── panel shell ─────────────────────────────────────────────────────────── */

/**
 * One quadrant of the 2×2 board: fixed header, independently scrolling body.
 * `min-h-0` on both the card and the body is what lets the grid row cap the
 * height instead of the content stretching the page.
 */
export function Panel({
  title,
  hint,
  icon,
  action,
  className,
  children,
}: {
  title: string;
  hint?: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      className={cn(
        "flex min-h-0 flex-col gap-0 overflow-hidden py-0",
        // Below the 4-column breakpoint the page scrolls; cap each panel so all four stay reachable.
        "max-h-[80vh] xl:max-h-none",
        className,
      )}
    >
      <CardHeader className="flex shrink-0 flex-row items-center gap-3 border-b bg-muted/40 px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-md border bg-background text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate text-sm">{title}</CardTitle>
          {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">{children}</CardContent>
    </Card>
  );
}

/** Small caps divider inside a panel. */
export function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-center gap-2 pt-1 first:pt-0">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</span>
      {count != null && count > 0 && (
        <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">{children}</p>
  );
}

/** Label + value pair, used for balances and quote breakdowns. */
export function Metric({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "positive";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-sm font-semibold tabular-nums",
          tone === "positive" ? "text-emerald-600" : "text-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/* ── status ──────────────────────────────────────────────────────────────── */

export const TONE: Record<string, string> = {
  waiting_payment: "border-border bg-muted text-muted-foreground",
  processing_payment: "border-sky-200 bg-sky-50 text-sky-700",
  paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
  shipped: "border-sky-200 bg-sky-50 text-sky-700",
  confirmed: "border-amber-200 bg-amber-50 text-amber-700",
  dispute: "border-red-200 bg-red-50 text-red-700",
  settling: "border-amber-200 bg-amber-50 text-amber-700",
  refunding: "border-sky-200 bg-sky-50 text-sky-700",
  refunded: "border-border bg-muted text-muted-foreground",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

export function StatusBadge({ status, label, busy }: { status: string; label: string; busy?: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 font-medium",
        TONE[status] ?? "border-border bg-muted text-muted-foreground",
        busy && "animate-pulse",
      )}
    >
      {busy ? "memproses…" : label}
    </Badge>
  );
}
