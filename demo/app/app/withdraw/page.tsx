import Withdraw from "../../Withdraw";

export const metadata = {
  title: "RivoKit — withdraw",
  description: "Seller EURC on Arc, cashed out to a bank via CPN or Circle Mint. Testnet only.",
};

/** The fiat exits: a balance row over the CPN and Circle Mint panels. */
export default function Page() {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-3">
      {/* See /app/page.tsx — the shared header's brand is not a page heading. */}
      <h1 className="sr-only">Withdraw</h1>
      <Withdraw />
    </main>
  );
}
