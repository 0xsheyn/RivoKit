import Marketplace from "../Marketplace";
import { boardSnapshot } from "../../lib/board.server";
import { getRivoKit } from "../../lib/rivokit.server";

export const metadata = {
  title: "RivoKit — market demo",
  description:
    "Cross-border settlement on Arc: multi-chain USDC in, floored EURC out. Testnet only.",
};

// Orders, balances and quotes — nothing here may be prerendered or cached.
export const dynamic = "force-dynamic";
// This is the segment the market page's Server Actions inherit, and `mpRelease`
// on a bank order runs a capture, a CPN quote and a broadcast in one call —
// each with its own polling loop. Left at the platform default, a release could
// be cut off after the escrow had been captured.
export const maxDuration = 300;

/**
 * The board: the storefront over a grid of role columns — Buyer, Host, Seller.
 * Each column is capped at seven order rows and scrolls on its own past that,
 * so the three end level whatever they hold. No scrollport here: the columns
 * declare their own height, and the document takes whatever is left over. The
 * fiat exits live on /app/withdraw.
 *
 * The data is read HERE, on the server, and handed to the client component as
 * its starting state. It used to be four reads the browser made after mount —
 * orders, balances, relay, price hints — each a Server Action, and Server
 * Actions run one at a time, so the board stayed empty until the last of them
 * came back.
 */
export default async function Page() {
  const initial = await boardSnapshot();
  // Static for the life of the process, but it takes the server's env to know
  // at all: the UI uses it to tell a demo order (server holds the key) from one
  // a connected wallet has to sign itself.
  let demoBuyer: string | null = null;
  try { demoBuyer = getRivoKit().addresses.buyer; } catch { /* env incomplete — the UI copes */ }

  return (
    <main className="min-h-0 flex-1 p-3">
      {/* The shared header carries the site name, not a page heading, so the
          page owns its own <h1>. Off-screen because the board announces itself
          — the storefront is right there — but a document with no h1 leaves a
          screen reader with nothing to land on. */}
      <h1 className="sr-only">Market demo</h1>
      <Marketplace initial={initial} demoBuyer={demoBuyer} />
    </main>
  );
}
