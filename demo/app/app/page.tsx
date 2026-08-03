import Marketplace from "../Marketplace";

export const metadata = {
  title: "RivoKit — market demo",
  description:
    "Cross-border settlement on Arc: multi-chain USDC in, floored EURC out. Testnet only.",
};

/**
 * The board: the storefront over a grid of role columns — Buyer, Host, Seller.
 * Each column is capped at seven order rows and scrolls on its own past that,
 * so the three end level whatever they hold. No scrollport here: the columns
 * declare their own height, and the document takes whatever is left over. The
 * fiat exits live on /app/withdraw.
 */
export default function Page() {
  return (
    <main className="min-h-0 flex-1 p-3">
      <Marketplace />
    </main>
  );
}
