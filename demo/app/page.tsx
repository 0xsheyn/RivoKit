import Marketplace from "./Marketplace";

export default function Page() {
  return (
    <main className="mx-auto max-w-7xl px-6 py-14">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">RivoKit</h1>
          <p className="mt-2 max-w-2xl text-neutral-400">
            Marketplace demo bertenaga RivoKit — pembeli bayar USDC dari chain mana pun, penjual di Eropa
            menerima <span className="text-neutral-200">EURC ber-floor</span> di Arc. Escrow non-custodial
            (Commerce Payments Protocol), bukan dompet platform.
          </p>
        </div>
        <a
          href="/sdk"
          className="shrink-0 rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800"
        >
          Lihat permukaan SDK →
        </a>
      </div>

      <div className="mt-5 rounded border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-200">
        <strong className="font-semibold">Testnet only — unaudited.</strong> Katalog, ongkir, kurir/tracking,
        dan leg fiat (EURC→EUR) di-<span className="font-mono">mock</span>. Yang <span className="font-semibold">nyata</span> di
        chain: order + FX terkunci, USDC masuk escrow, capture, swap ber-floor, refund + bridge-back.
        Verifikator pihak-ketiga (kurir/arbiter) diperankan panel Host.
      </div>

      <div className="mt-8">
        <Marketplace />
      </div>

      <footer className="mt-12 border-t border-neutral-800 pt-6 text-xs text-neutral-600">
        Arc Testnet · escrow CPP non-custodial · 203 tes unit hijau ·{" "}
        <a href="/sdk" className="text-sky-400 hover:underline">panel penguji SDK</a>
      </footer>
    </main>
  );
}
