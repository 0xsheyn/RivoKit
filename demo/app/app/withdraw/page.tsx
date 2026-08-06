import Withdraw from "../../Withdraw";
import { withdrawSnapshot } from "../../../lib/board.server";

export const metadata = {
  title: "RivoKit — withdraw",
  description: "Seller EURC on Arc, cashed out to a bank via CPN or Circle Mint. Testnet only.",
};

export const dynamic = "force-dynamic";
// The Server Actions on this page are the slow ones: a CPN broadcast approves
// Permit2, waits for the receipt, then follows the payment lifecycle to a
// terminal status. Left at the platform default it could be cut off after the
// broadcast — the one point in the flow that cannot be undone.
export const maxDuration = 300;

/**
 * The fiat exits: a balance row over the CPN and Circle Mint panels.
 *
 * Read on the server, in parallel, once. Eight components used to fetch their
 * own slice on mount through the Server Action queue — including two asking
 * Circle Mint for the very same balances — so the page filled in one panel at a
 * time, behind whichever call happened to be slowest.
 */
export default async function Page() {
  const initial = await withdrawSnapshot();

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-3">
      {/* See /app/page.tsx — the shared header's brand is not a page heading. */}
      <h1 className="sr-only">Withdraw</h1>
      <Withdraw initial={initial} />
    </main>
  );
}
