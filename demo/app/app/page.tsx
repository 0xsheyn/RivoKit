import Marketplace from "../Marketplace";

export const metadata = {
  title: "RivoKit — market demo",
  description:
    "Cross-border settlement on Arc: multi-chain USDC in, floored EURC out. Testnet only.",
};

/**
 * Single-screen board: the storefront over a grid of role columns — Buyer,
 * Seller, Host. Nothing below the fold; each column scrolls on its own. The
 * fiat exits live on /app/withdraw.
 */
export default function Page() {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-3 xl:overflow-hidden">
      <Marketplace />
    </main>
  );
}
