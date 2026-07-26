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
  { id: "kbd", name: "Hot-Swap Mechanical Keyboard", blurb: "Aluminium case, linear switches, PBT keycaps", seller: "TechHaus Berlin", emoji: "⌨️", priceEURMinor: "3500000" },
  { id: "hdp", name: "Studio Headphones", blurb: "Over-ear, 40mm drivers, detachable cable", seller: "AudioLab Wien", emoji: "🎧", priceEURMinor: "4900000" },
  { id: "cam", name: "Instant Camera", blurb: "Prints on the spot, 60mm lens", seller: "Retro Optics Praha", emoji: "📷", priceEURMinor: "4500000" },
  { id: "wch", name: "Automatic Watch", blurb: "Sapphire crystal, 50m water resistance", seller: "Horloge Genève", emoji: "⌚", priceEURMinor: "5000000" },
  { id: "mug", name: "Enamel Ceramic Mug", blurb: "350ml, heat resistant, logo printed", seller: "Nordic Home Oslo", emoji: "☕", priceEURMinor: "2500000" },
];

export function productById(id: string): Product | undefined {
  return CATALOG.find((p) => p.id === id);
}

/** €12.34 from "12340000". */
export function fmtEUR(minor: string | null | undefined): string {
  if (minor == null) return "—";
  return `€${(Number(minor) / 1e6).toFixed(2)}`;
}
