"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/* ── format ──────────────────────────────────────────────────────────────── */

/** "12.34" from micro-units; em dash when unknown. */
export const usd = (m: string | null | undefined) => (m == null ? "—" : (Number(m) / 1e6).toFixed(2));
export const num = (m: string | null | undefined) => (m == null ? 0 : Number(m) / 1e6);
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

/* ── panel shell ─────────────────────────────────────────────────────────── */

/**
 * One column of the board: fixed header, independently scrolling body.
 * Card, CardHeader and CardContent keep their stock shadcn styling — only the
 * layout classes needed to cap the height are added. `min-h-0` on both the card
 * and the body is what lets the body scroll instead of the content stretching
 * the page.
 *
 * The cap itself arrives as a pixel value rather than a class: the board sizes
 * its columns to a whole number of order rows, and only the DOM knows how tall
 * an order row is. `bodyRef` is what the measuring side reads. With no cap
 * passed the panel is content-sized, which is what every panel wants before
 * there are enough orders to need one.
 */
export function Panel({
  title,
  hint,
  icon,
  action,
  className,
  bodyRef,
  bodyMaxHeight,
  children,
}: {
  title: string;
  hint?: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  bodyRef?: React.Ref<HTMLDivElement>;
  bodyMaxHeight?: number | null;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("min-h-0 overflow-hidden", className)}>
      <CardHeader className="shrink-0">
        {/* Every panel heading across the demo is 16px bold — one step above the
            cards nested inside it, which stay at 14px. */}
        <CardTitle className="flex items-center gap-2 text-base font-bold">
          <span className="text-muted-foreground">{icon}</span>
          <span className="truncate">{title}</span>
        </CardTitle>
        {hint && <CardDescription className="truncate">{hint}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      {/* `py-px` is not spacing: the preset's Card draws its edge as an outset
          `ring-1`, which the scroll container clips flush against its own top
          and bottom — the first card's upper edge came out shaved off. One
          pixel of room inside the scrollport is enough to let the ring land. */}
      <CardContent
        ref={bodyRef}
        style={bodyMaxHeight != null ? { maxHeight: bodyMaxHeight } : undefined}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto py-px"
      >
        {children}
      </CardContent>
    </Card>
  );
}

/** Small caps divider inside a panel. */
export function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-center gap-2 pt-1 first:pt-0">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</span>
      {count != null && count > 0 && (
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      )}
      <Separator className="flex-1" />
    </div>
  );
}

/** `className` exists for the history panels, which keep the smaller 12px body. */
export function Empty({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("rounded-2xl border border-dashed px-3 py-6 text-center text-sm text-muted-foreground", className)}>
      {children}
    </p>
  );
}

/** Label + value pair, used for balances and quote breakdowns. */
export function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-sm font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/* ── status tone ─────────────────────────────────────────────────────────── */

/**
 * Six meanings, and every status badge in the demo picks one. Before this the
 * badge colour came from the stock variants, which meant a badge was black
 * whether it said "completed" or "refunded" — the word carried the whole
 * message. Now colour and word say the same thing, and they say it the same way
 * in the order list, the CPN history and the Mint history.
 */
export type Tone = "neutral" | "progress" | "warning" | "success" | "refund" | "danger";

/**
 * Tinted fill + saturated text, the same idiom the shadcn preset uses for its
 * own destructive badge. The five hues are `--chart-1…5` from globals.css, so
 * the palette has exactly one definition.
 */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border text-muted-foreground",
  progress: "border-transparent bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  refund: "border-transparent bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  success: "border-transparent bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  warning: "border-transparent bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  danger: "border-transparent bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
};

/** Marketplace order view states and SDK `OrderState`, in one table. */
const STATE_TONE: Record<string, Tone> = {
  // Marketplace order view
  waiting_payment: "warning",
  processing_payment: "progress",
  paid: "success",
  shipped: "progress",
  confirmed: "progress",
  settling: "progress",
  dispute: "danger",
  refunding: "refund",
  refunded: "refund",
  completed: "success",
  // The authorization window closed before the escrow ever collected. Nothing
  // was taken, but nothing more can happen either.
  expired: "danger",
  // SDK OrderState
  created: "neutral",
  funding_pending: "warning",
  funded: "success",
  settlement_pending: "progress",
  released: "success",
  payout_pending: "warning",
  paid_out: "success",
  refund_pending: "refund",
  failed: "danger",
};

export const stateTone = (state: string): Tone => STATE_TONE[state] ?? "neutral";

/**
 * CPN and Circle Mint each report their own vocabulary — SCREAMING_SNAKE for
 * CPN, lower case for Mint — and both keep adding statuses. Matching on
 * substrings rather than enumerating means a status nobody has seen yet still
 * lands in the right colour instead of falling through to grey.
 */
export function railTone(status: string | null | undefined): Tone {
  const s = (status ?? "").toUpperCase();
  if (!s) return "neutral";
  if (s.startsWith("COMPLETE") || s === "PAID" || s === "SETTLED") return "success";
  if (/FAIL|DENIED|REJECT|EXPIRE|CANCEL/.test(s)) return "danger";
  if (s.includes("REFUND")) return "refund";
  if (s.includes("PENDING") || s === "CREATED" || s === "QUEUED") return "warning";
  return "progress";
}

/** `CRYPTO_FUNDS_PENDING` → `crypto funds pending`, so rail statuses read like the rest. */
export const statusLabel = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/_/g, " ") || "—";

export function ToneBadge({
  tone,
  className,
  children,
}: {
  tone: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return <Badge variant="outline" className={cn("shrink-0", TONE_CLASS[tone], className)}>{children}</Badge>;
}

export function StatusBadge({ status, label, busy }: { status: string; label: string; busy?: boolean }) {
  return (
    <ToneBadge tone={busy ? "progress" : stateTone(status)} className={cn(busy && "animate-pulse")}>
      {busy ? "working…" : label}
    </ToneBadge>
  );
}
