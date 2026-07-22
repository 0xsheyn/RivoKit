import { ArrowUpRight, ShieldCheck } from "lucide-react";
import Marketplace from "./Marketplace";
import { Button } from "@/components/ui/button";

export default function Page() {
  return (
    <main className="w-full px-5 py-8 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-[1600px]">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <ShieldCheck className="size-4" />
              </span>
              <h1 className="text-2xl font-semibold tracking-tight">RivoKit</h1>
            </div>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Marketplace demo bertenaga RivoKit — pembeli bayar USDC dari chain mana pun, penjual di Eropa
              menerima <span className="font-medium text-foreground">EURC ber-floor</span> di Arc. Escrow
              non-custodial (Commerce Payments Protocol), bukan dompet platform.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href="/sdk">
              Lihat permukaan SDK
              <ArrowUpRight className="size-4" />
            </a>
          </Button>
        </header>

        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <strong className="font-semibold">Testnet only — unaudited.</strong> Katalog, ongkir, kurir/tracking,
          dan leg fiat (EURC→EUR) di-<span className="font-mono text-[13px]">mock</span>. Yang{" "}
          <span className="font-semibold">nyata</span> di chain: order + FX terkunci, USDC masuk escrow, capture,
          swap ber-floor, refund + bridge-back. Verifikator pihak-ketiga (kurir/arbiter) diperankan panel Host.
        </div>

        <div className="mt-8">
          <Marketplace />
        </div>

        <footer className="mt-12 border-t pt-6 text-xs text-muted-foreground">
          Arc Testnet · escrow CPP non-custodial · 203 tes unit hijau ·{" "}
          <a href="/sdk" className="font-medium text-foreground underline-offset-4 hover:underline">
            panel penguji SDK
          </a>
        </footer>
      </div>
    </main>
  );
}
