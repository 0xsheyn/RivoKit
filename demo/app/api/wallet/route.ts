import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { walletSnapshot } from "../../../lib/board.server.ts";

/**
 * A connected wallet's own balances: `?address=0x…&fields=arc,eurc,src`.
 *
 * Read-only and about an address the caller already supplied — it reveals
 * nothing a block explorer does not. What it replaces is three Server Actions
 * (`mpAddrArcUsdc`, `mpAddrEurc`, `mpAddrSrcUsdc`), two of which fired for the
 * same address from two different components on the market page.
 *
 * `fields` defaults to `arc` alone: the source-chain sweep is four more RPC
 * calls against endpoints that rate-limit, and only the funding rail selector
 * ever looks at it.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address") ?? "";
  // Validated before it reaches a contract read: `getAddress` would throw
  // inside the reader and surface as a 500, which reads as "the server is
  // broken" rather than "that is not an address".
  if (!isAddress(address)) {
    return NextResponse.json({ ok: false, error: "address is missing or malformed" }, { status: 400 });
  }

  const asked = (url.searchParams.get("fields") ?? "arc").split(",");
  const fields = {
    arc: asked.includes("arc"),
    eurc: asked.includes("eurc"),
    src: asked.includes("src"),
  };

  try {
    return NextResponse.json(
      { ok: true, ...(await walletSnapshot(address, fields)) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
