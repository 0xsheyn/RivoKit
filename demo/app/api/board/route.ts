import { NextResponse } from "next/server";
import { boardSnapshot } from "../../../lib/board.server.ts";

/**
 * The market page's poll, as a plain GET.
 *
 * WHY A ROUTE HANDLER AND NOT A SERVER ACTION
 *
 * This used to be two Server Actions (`mpListOrders`, `mpBalances`) called from
 * a four-second interval. Server Actions are POSTs that the App Router runs
 * through ONE queue, shared with navigation — so a poll in flight delays the
 * next poll, the next click, and the next route change. A GET has none of that:
 * several can be in flight at once, and nothing waits behind them.
 *
 * The reads inside are already independent and already degrade one by one
 * (`boardSnapshot`), so a rate-limited RPC costs one number rather than the page.
 */
export const dynamic = "force-dynamic";
// Chain reads and Circle calls, several of them, behind a rate-limited public
// RPC. The platform default would cut this off mid-read on a bad day.
export const maxDuration = 60;

export async function GET() {
  try {
    const snapshot = await boardSnapshot();
    return NextResponse.json(
      { ok: true, ...snapshot },
      // Never cached: every field is a live balance or an order state, and a
      // cached board is a board that lies about where the money is.
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
