import { NextResponse } from "next/server";
import { withdrawSnapshot } from "../../../lib/board.server.ts";

/**
 * The withdraw page's poll: balances, seller, corridors, CPN history, Mint.
 *
 * One GET for what was eight Server Actions fired on mount — two of them
 * (`MintRedeem` and `SendEurcToMint`) asking for the same thing — each waiting
 * for the one before it. The parts are independent, so `withdrawSnapshot`
 * awaits them together and lets each fail on its own.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json(
      { ok: true, ...(await withdrawSnapshot()) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
