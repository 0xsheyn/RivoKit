/**
 * Demo storefront catalog. Pure data — safe to import from client and server.
 *
 * Prices are micro-EURC (6 decimals): what the seller is GUARANTEED to receive.
 * Every listing settles to the single demo merchant wallet — the seller names
 * are cosmetic (one testnet wallet plays every shop).
 */
export type Product = {
  id: string;
  name: string;
  blurb: string;
  seller: string;
  emoji: string;
  /** micro-EURC, the guaranteed price €P. */
  priceEURMinor: string;
};

export const CATALOG: Product[] = [
  { id: "kbd", name: "Keyboard Mekanik Hot-Swap", blurb: "Aluminium, switch linear, PBT keycaps", seller: "TechHaus Berlin", emoji: "⌨️", priceEURMinor: "3500000" },
  { id: "hdp", name: "Headphone Studio", blurb: "Over-ear, 40mm driver, kabel lepas", seller: "AudioLab Wien", emoji: "🎧", priceEURMinor: "5900000" },
  { id: "cam", name: "Kamera Instan", blurb: "Cetak langsung, lensa 60mm", seller: "Retro Optics Praha", emoji: "📷", priceEURMinor: "8900000" },
  { id: "wch", name: "Jam Tangan Otomatis", blurb: "Sapphire, water-resist 50m", seller: "Horloge Genève", emoji: "⌚", priceEURMinor: "12000000" },
];

export function productById(id: string): Product | undefined {
  return CATALOG.find((p) => p.id === id);
}

/** €12.34 from "12340000". */
export function fmtEUR(minor: string | null | undefined): string {
  if (minor == null) return "—";
  return `€${(Number(minor) / 1e6).toFixed(2)}`;
}
